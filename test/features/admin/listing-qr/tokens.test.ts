/** The QR generator's minting contract: a POST that succeeds signs a token
 * carrying exactly the submitted values, scoped to the listing. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { extractAndVerifyToken, extractToken, postQr } from "./shared.ts";

describeWithEnv("admin listing QR tokens", { db: true }, () => {
  test("a refused form mints no token", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 2,
      unitPrice: 500,
    });
    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/qr`,
      { quantity: "5" },
    );
    const body = await response.text();
    expect(body).toContain("Quantity cannot exceed 2");
    expect(extractToken(body)).toBeNull();
  });

  test("accepts a valid daily date and signs a token", async () => {
    // A daily listing's submitted date must be one of its bookable dates; a
    // valid one passes and a token is generated (covers the date-allowed path).
    const listing = await createDailyTestListing({ unitPrice: 500 });
    const { getBookableStartDates } = await import("#shared/dates.ts");
    const { getActiveHolidays } = await import("#db/holidays.ts");
    const { getListingWithCount } = await import("#db/listings/records.ts");
    const date = getBookableStartDates(
      (await getListingWithCount(listing.id))!,
      await getActiveHolidays(),
    )[0]!;
    const { response, payload } = await postQr(listing)({
      customer_name: "Ada",
      date,
      quantity: "1",
      value: "5.00",
    });
    expect(response.status).toBe(200);
    expect(payload.d).toBe(date);
  });

  test("accepts any price for fixed-price listings as a one-off override", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      unitPrice: 500,
    });
    // Way above the listing's unit_price; allowed for the override.
    const { body, response } = await postQr(listing)({
      customer_name: "Ada",
      quantity: "1",
      value: "200.00",
    });
    expect(response.status).toBe(200);
    expect(body).toContain("/qr-book?t=");
    expect(body).toContain("<svg");
  });

  test("accepts a zero price override for a fixed-price listing", async () => {
    // A fixed-price listing has no minimum, so a free override is valid.
    const listing = await createTestListing({
      maxAttendees: 10,
      unitPrice: 500,
    });
    const { response, payload } = await postQr(listing)({
      customer_name: "Ada",
      quantity: "1",
      value: "0.00",
    });
    expect(response.status).toBe(200);
    expect(payload.v).toBe(0);
  });

  test("signed token embeds submitted values and matches the listing slug", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 5,
      unitPrice: 500,
    });
    const { payload } = await postQr(listing)({
      customer_name: "Ada Lovelace",
      quantity: "3",
      value: "12.50",
    });
    expect(payload.n).toBe("Ada Lovelace");
    expect(payload.v).toBe(1250);
    expect(payload.q).toBe(3);
  });

  test("generates a token when customer_name is omitted, defaulting quantity to 1", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      unitPrice: 500,
    });
    const { response, payload } = await postQr(listing)({});
    expect(response.status).toBe(200);
    expect(payload.n).toBe("");
    expect(payload.q).toBe(1);
    expect(payload.v).toBe(-1);
  });

  test("tokens are scoped to their listing slug", async () => {
    const a = await createTestListing({ maxAttendees: 10, unitPrice: 500 });
    const b = await createTestListing({ maxAttendees: 10, unitPrice: 500 });
    const { body } = await postQr(a)({
      customer_name: "Ada",
      quantity: "1",
      value: "5.00",
    });
    // postQr already proved the token verifies against its own listing, so
    // the helper's refusal is what a mismatched slug meets.
    await expect(extractAndVerifyToken(body, b.slug)).rejects.toThrow(
      "QR token failed verification",
    );
  });
});
