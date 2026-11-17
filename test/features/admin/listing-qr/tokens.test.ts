/** The QR generator's minting contract: a POST that succeeds signs a token
 * carrying exactly the submitted values, scoped to the listing. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import {
  bookableStartDates,
  createDailyTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { createPricedListing } from "#test-utils/db-helpers/priced-listing.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { extractAndVerifyToken, extractToken, postQr } from "./shared.ts";

describeWithEnv("admin listing QR tokens", { db: true }, () => {
  test("a refused form mints no token", async () => {
    const listing = await createPricedListing({ maxQuantity: 2 });
    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/qr`,
      { quantity: "5" },
    );
    const body = await response.text();
    assertStringIncludes(body, "Quantity must be at most 2.");
    expect(extractToken(body)).toBeNull();
  });

  test("accepts a valid daily date and signs a token", async () => {
    // A daily listing's submitted date must be one of its bookable dates; a
    // valid one passes and a token is generated (covers the date-allowed path).
    const listing = await createDailyTestListing({ unitPrice: 500 });
    const date = (await bookableStartDates(listing.id))[0]!;
    const { response, payload } = await postQr(listing)({
      customerName: "Ada",
      date,
      quantity: "1",
      value: "5.00",
    });
    expect(response.status).toBe(200);
    expect(payload.d).toBe(date);
  });

  test("accepts any price for fixed-price listings as a one-off override", async () => {
    const listing = await createPricedListing();
    // Way above the listing's unit_price; allowed for the override.
    const { body, response } = await postQr(listing)({
      customerName: "Ada",
      quantity: "1",
      value: "200.00",
    });
    expect(response.status).toBe(200);
    expectIncludesAll(body, ["/qr-book?t=", "<svg"]);
  });

  test("accepts a zero price override for a fixed-price listing", async () => {
    // A fixed-price listing has no minimum, so a free override is valid.
    const listing = await createPricedListing();
    const { response, payload } = await postQr(listing)({
      customerName: "Ada",
      quantity: "1",
      value: "0.00",
    });
    expect(response.status).toBe(200);
    expect(payload.v).toBe(0);
  });

  test("signed token embeds submitted values and matches the listing slug", async () => {
    const listing = await createPricedListing({ maxQuantity: 5 });
    const { payload } = await postQr(listing)({
      customerName: "Ada Lovelace",
      quantity: "3",
      value: "12.50",
    });
    expect(payload).toMatchObject({ n: "Ada Lovelace", q: 3, v: 1250 });
  });

  test("generates a token when customer_name is omitted, defaulting quantity to 1", async () => {
    const listing = await createPricedListing();
    const { response, payload } = await postQr(listing)({});
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ n: "", q: 1, v: -1 });
  });

  test("tokens are scoped to their listing slug", async () => {
    const [a, b] = await createListingPair({
      maxAttendees: 10,
      unitPrice: 500,
    });
    const { body } = await postQr(a)({
      customerName: "Ada",
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
