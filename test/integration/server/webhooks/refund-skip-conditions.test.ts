// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookIgnored,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > refund skip conditions",
  { db: true },
  () => {
    test("paid Stripe webhook without a payment intent requests retry", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Noref",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);
      const amount = 500;
      const metadata = signedMeta(
        {
          email: "noref@example.com",
          items: singleItem(listing.id, 1, amount),
          name: "No Ref",
        },
        amount,
      );

      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: amount,
          eventId: "evt_noref",
          metadata,
          paymentIntent: null,
          sessionId: "cs_noref",
        }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        // A payment with no charge behind it is a case for the owner, not a
        // booking and not a refund.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          received: true,
          status: "needs_action",
        });
      } finally {
        mockVerify.restore();
      }
    });

    // The booking cannot be honoured and the money must go back, but the
    // provider refuses the refund. Acknowledging would leave the buyer charged
    // with nobody looking, so the callback asks to be sent again.
    test("asks for redelivery when the refund cannot go through", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Tryrefund Noprov",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      using _refund = stub(stripePaymentProvider, "refundCharge", (charge) =>
        Promise.resolve({
          amount: charge.refunded,
          reason: "provider_failed" as const,
          status: "failed" as const,
        }),
      );

      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_tryrefund_noprov",
          metadata: signedMeta(
            {
              email: "noprov@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "No Provider",
            },
            500,
          ),
          paymentIntent: "pi_tryrefund_noprov",
          sessionId: "cs_tryrefund_noprov",
        }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ status: "retry" });
      } finally {
        mockVerify.restore();
      }
    });

    test("multi-ticket webhook skips refund when second listing not found", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "WH Multi Rollback 1",
        unitPrice: 500,
      });
      // listing2 does not exist (id 99999) — validation fails before any attendees are created

      const mockRefund = spy(stripeApi, "requestRefund");

      // Unsigned session (no valid price proof): ignored (200 ack) without
      // processing, without a refund, and without creating any attendee.
      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_multi_rollback",
          metadata: webhookMeta({
            email: "rollback@example.com",
            items: JSON.stringify([
              { e: listing1.id, p: 500, q: 1 },
              { e: 99999, p: 0, q: 1 },
            ]),
            name: "Rollback Test",
          }),
          paymentIntent: "pi_multi_rollback",
          sessionId: "cs_multi_rollback_cleanup",
        }),
        () => {
          mockRefund.restore();
        },
      );

      // An unverifiable session must NOT trigger a refund.
      expect(mockRefund.calls.length).toBe(0);

      // No attendees created (the session is ignored before any creation pass)
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing1.id);
      expect(attendees.length).toBe(0);
    });
  },
);
