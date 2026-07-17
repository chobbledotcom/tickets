import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { checkoutStagesApi } from "#shared/db/checkout-stages.ts";
import { queryAll } from "#shared/db/client.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import {
  stagePaymentCallback,
  stageStripeCallback,
} from "#test-utils/staged-payments.ts";

describeWithEnv("test staged payment fixtures", { db: true }, () => {
  afterEach(() => resetStripeClient());

  test("does not stage a balance payment as a new attendee", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const metadata = signedMeta(
      {
        balance_attendee_id: "42",
        email: "balance@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Balance Buyer",
      },
      1000,
    );
    await stagePaymentCallback({
      amountTotal: 1000,
      metadata,
      paymentReference: "pi_balance_fixture",
      sessionId: "cs_balance_fixture",
    });
    expect(
      await checkoutStagesApi.loadByPaymentSession("cs_balance_fixture"),
    ).toBeNull();
    expect(await queryAll("SELECT id FROM attendees", [])).toEqual([]);
  });

  test("stages every required field from a retrieved Stripe session", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const metadata = signedMeta(
      {
        email: "stripe-fixture@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Stripe Fixture",
      },
      1000,
    );
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_stripe_fixture",
        metadata,
        payment_intent: "pi_stripe_fixture",
        payment_status: "paid",
      } as never),
    );
    try {
      await stageStripeCallback("cs_stripe_fixture");
      expect(
        await checkoutStagesApi.loadByPaymentSession("cs_stripe_fixture"),
      ).toMatchObject({ provider: "stripe", state: "pending" });
    } finally {
      retrieve.restore();
    }
  });
});
