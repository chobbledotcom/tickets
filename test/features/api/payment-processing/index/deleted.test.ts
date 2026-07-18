import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { getDb } from "#shared/db/client.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  intentFor,
  paidSession,
  stageSession,
} from "../staged-runtime.helpers.ts";

describeWithEnv("payment processing deleted listing", { db: true }, () => {
  test("stores a listing-removed refund when the signed listing was deleted", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const intent = intentFor(listing.id);
    await stageSession("deleted-listing", intent);
    await getDb().execute("DELETE FROM listings WHERE id = ?", [listing.id]);
    using _refund = stub(stripePaymentProvider, "refundPayment", () =>
      Promise.resolve("refunded"),
    );
    const result = await processPaymentSession(
      "deleted-listing",
      paidSession("deleted-listing", intent),
    );
    expect(result).toMatchObject({
      detail:
        "Listing not found for a signed session (session=deleted-listing)",
      error: "We couldn't complete your booking.",
      refundStatus: "refunded",
      status: 200,
      success: false,
    });
  });
});
