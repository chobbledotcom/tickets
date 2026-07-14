// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { getDb } from "#shared/db/client.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectRefundRoundTripLegs,
  expectStage,
  paidReturn,
  requireIntent,
  stubFailedRefund,
} from "./server-payment-staging-helpers.ts";

// jscpd:ignore-end

describeWithEnv("paid checkout staging — refund rail", { db: true }, () => {
  setupErrorSpy();
  afterEach(() => resetStripeClient());

  test("never activates after a completed refund was first reported as failed", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    const { checkout, getCaptured } = stubCheckout("cs_staged_false_negative");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "false-negative@example.com",
        name: "False Negative Buyer",
      });
      const filler = await bookAttendee(listing, {
        email: "false-negative-filler@example.com",
        name: "False Negative Filler",
      });
      if (!filler.success) throw new Error("Expected filler booking");
      const intent = requireIntent(getCaptured);

      // Stripe completed the refund remotely, but both the create response and
      // the immediate status read failed locally.
      {
        using _refund = stubFailedRefund();
        const first = await paidReturn(
          "cs_staged_false_negative",
          intent,
          1000,
        );
        expect(first.status).toBe(200);
      }
      await expectStage("cs_staged_false_negative", "refunding", 0);
      expect(
        (await getDb().execute("SELECT kind FROM transfers")).rows,
      ).toEqual([]);

      // Capacity returns before redelivery. The retry must finish the refund,
      // never activate a ticket for money already returned.
      await deleteAttendee(filler.attendees[0]!.id);
      using _refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(null),
      );
      using refunded = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve({
          id: "pi_cs_staged_false_negative",
          latest_charge: { refunded: true },
        }),
      );
      const retry = await paidReturn("cs_staged_false_negative", intent, 1000);
      expect(await retry.text()).toContain("automatically refunded");
      await expectStage("cs_staged_false_negative", "failed", 0);
      await expectRefundRoundTripLegs();
      expect(refunded.calls.length).toBe(1);
    } finally {
      checkout.restore();
    }
  });
});
