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
  postWebhookAndAssert,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > refund skip conditions",
  { db: true },
  () => {
    test("webhook rejects a paid session with no provider payment reference", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Noref",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      // A paid session with no payment_intent is refused at the provider
      // boundary (it would be unrefundable), so the webhook resolves no
      // session and acks without processing — even for a deactivated listing.
      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_noref",
          metadata: signedMeta(
            {
              email: "noref@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "No Ref",
            },
            500,
          ),
          paymentIntent: null,
          sessionId: "cs_noref",
        }),
      );

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          // The boundary rejects the paid session as a blank reference; the
          // webhook acknowledges it without processing (nothing to refund).
          expect(json.error).toBe("rejected");
          expect(json.processed).toBe(false);
        },
      );
    });

    test("webhook retries when the refund of a rejected paid session fails", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Malformed",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      // A paid charge the boundary cannot read (fractional amount) with a
      // usable reference is refunded; a refund the provider refuses must not
      // be acked away, so the webhook answers 503 for the provider to retry.
      const refundStub = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(null),
      );
      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 10.5,
          eventId: "evt_malformed",
          metadata: signedMeta(
            {
              email: "malformed@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Malformed",
            },
            500,
          ),
          paymentIntent: "pi_malformed",
          sessionId: "cs_malformed",
        }),
      );

      try {
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(503);
        await response.text(); // the plain retry body
        // The retry is only correct if the refund was genuinely attempted on
        // the captured charge — a 503 returned before the provider call would
        // leave the money with Stripe and nothing asking for it back.
        expect(refundStub.calls.map((call) => call.args)).toEqual([
          ["pi_malformed"],
        ]);
      } finally {
        mockVerify.restore();
        refundStub.restore();
      }
    });

    test("tryRefund logs error when no payment provider is configured", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Tryrefund Noprov",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      // The provider can disappear between the initial webhook check and the
      // refund attempt. The refund stays retryable when no fallback resolves.
      const { existingPaymentProviderApi } = await import(
        "#shared/existing-payment-provider.ts"
      );
      const { paymentsApi } = await import("#shared/payments.ts");
      const origGetCurrent = paymentsApi.getConfiguredProvider;
      let callCount = 0;
      const mockGetConfigured = stub(
        paymentsApi,
        "getConfiguredProvider",
        () => {
          callCount++;
          return callCount <= 1 ? origGetCurrent() : null;
        },
      );
      const mockGetLast = stub(
        existingPaymentProviderApi,
        "getRemembered",
        () => null,
      );
      const mockGetSingle = stub(
        existingPaymentProviderApi,
        "getConfigured",
        () => [],
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
        // The payment has a reference but the refund couldn't go through (no
        // provider), so it is retryable: 5xx for the provider to re-deliver once
        // reconfigured, rather than ack a still-charged customer.
        expect(response.status).toBe(503);
        expect(await response.text()).toContain("no longer accepting");
      } finally {
        mockVerify.restore();
        mockGetConfigured.restore();
        mockGetLast.restore();
        mockGetSingle.restore();
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

      const mockRefund = spy(stripeApi, "refundPayment");

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
