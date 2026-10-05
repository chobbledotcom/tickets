/** The QR generator honours the listing's minimum quantity: a below-minimum
 *  prefill is refused at generation with the form's literal style, on both the
 *  POST form and the JSON refresh. Split from the main QR suite to keep both
 *  under the ~400-line target. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { verifyQrBookToken } from "#shared/qr-token.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { extractToken, postQr } from "./shared.ts";

/** A listing that sells at least 3 per purchase, at most 5. */
const batchedListing = () =>
  createTestListing({
    maxAttendees: 10,
    maxQuantity: 5,
    minimumQuantity: 3,
    unitPrice: 500,
  });

describeWithEnv("admin listing QR minimum quantity", { db: true }, () => {
  test("the POST form refuses a below-minimum quantity and mints no token", async () => {
    const listing = await batchedListing();
    const { response } = await adminFormPost(
      `/admin/listing/${listing.id}/qr`,
      { quantity: "2" },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Quantity must be at least 3");
    expect(extractToken(body)).toBeNull();
  });

  test("the POST form accepts a quantity exactly at the minimum", async () => {
    const listing = await batchedListing();
    const { payload } = await postQr(listing)({
      customer_name: "Ada",
      quantity: "3",
      value: "5.00",
    });
    expect(payload.q).toBe(3);
  });

  test("the JSON refresh answers 400 below the minimum", async () => {
    const listing = await batchedListing();
    const response = await adminGet(
      `/admin/listing/${listing.id}/qr.json?quantity=2`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Quantity must be at least 3");
  });

  test("the JSON refresh honours a quantity exactly at the minimum", async () => {
    const listing = await batchedListing();
    const response = await adminGet(
      `/admin/listing/${listing.id}/qr.json?customer_name=Ada&value=5.00&quantity=3`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; url: string };
    expect(body.ok).toBe(true);
    const match = body.url.match(/\/qr-book\?t=([^&]+)/);
    expect(match).not.toBeNull();
    const payload = await verifyQrBookToken(
      listing.slug,
      decodeURIComponent(match![1]!),
    );
    expect(payload!.q).toBe(3);
  });
});
