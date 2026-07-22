import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { queryAll } from "#shared/db/client.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import {
  stagePaymentCallback,
  stageStripeCallback,
} from "#test-utils/staged-payments.ts";

describeWithEnv("test staged payment fixtures", { db: true }, () => {
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
      await loadCheckoutStageByPaymentSession("cs_balance_fixture"),
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
        await loadCheckoutStageByPaymentSession("cs_stripe_fixture"),
      ).toMatchObject({ provider: "stripe", state: "pending" });
    } finally {
      retrieve.restore();
    }
  });

  test("fails when signed metadata names a listing that was not loaded", async () => {
    const metadata = signedMeta(
      {
        items: singleItem(999999, 1, 1000),
        name: "Missing listing",
      },
      1000,
    );
    await expect(
      stagePaymentCallback({
        amountTotal: 1000,
        metadata,
        paymentReference: "pi_missing_fixture_listing",
        sessionId: "cs_missing_fixture_listing",
      }),
    ).rejects.toThrow("Listing 999999 was not loaded for staged payment");
  });

  test("restores an inactive listing when another listing is missing", async () => {
    const inactive = await createTestListing({ unitPrice: 1000 });
    await deactivateTestListing(inactive.id);
    const missingId = 999999;
    const metadata = signedMeta(
      {
        items: JSON.stringify([
          { e: inactive.id, p: 1000, q: 1 },
          { e: missingId, p: 1000, q: 1 },
        ]),
        name: "Mixed listings",
      },
      2000,
    );

    await expect(
      stagePaymentCallback({
        amountTotal: 2000,
        metadata,
        paymentReference: "pi_mixed_fixture_listings",
        sessionId: "cs_mixed_fixture_listings",
      }),
    ).rejects.toThrow(`Listing ${missingId} was not loaded for staged payment`);
    expect(
      await queryAll("SELECT active FROM listings WHERE id = ?", [inactive.id]),
    ).toEqual([{ active: 0 }]);
  });

  test("fallback staging preserves provider checkout identifiers", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const metadata = signedMeta(
      {
        items: singleItem(listing.id, 1, 1000),
        name: "Square fallback",
      },
      1000,
    );
    const stage = stub(attendeesApi, "createStagedCheckoutAtomic", () =>
      Promise.resolve({ reason: "capacity_exceeded" as const, success: false }),
    );
    try {
      await stagePaymentCallback({
        amountTotal: 1000,
        metadata,
        paymentReference: "payment_square_fixture",
        provider: "square",
        providerCheckoutId: "link_square_fixture",
        sessionId: "order_square_fixture",
      });
      expect(
        await loadCheckoutStageByPaymentSession("order_square_fixture"),
      ).toMatchObject({
        paymentSessionId: "order_square_fixture",
        provider: "square",
        providerCheckoutId: "link_square_fixture",
      });
      await stagePaymentCallback({
        amountTotal: 1000,
        metadata,
        paymentReference: "payment_stripe_fixture",
        sessionId: "session_stripe_fixture",
      });
      expect(
        await loadCheckoutStageByPaymentSession("session_stripe_fixture"),
      ).toMatchObject({
        paymentSessionId: "session_stripe_fixture",
        provider: "stripe",
        providerCheckoutId: "session_stripe_fixture",
      });
    } finally {
      stage.restore();
    }
  });
});
