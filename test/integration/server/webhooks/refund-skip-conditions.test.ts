// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  ALL_SETTINGS_KEYS,
  CONFIG_KEYS,
  settings,
} from "#shared/db/settings.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
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
    test("webhook refund returns false when payment reference is null", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Noref",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

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
          sessionId: "cs_noref",
        }),
      );

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          expect(json.error).toContain("no longer accepting");
        },
      );
    });

    test("tryRefund logs error when no payment provider is configured", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Tryrefund Noprov",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      const event = checkoutSessionEvent({
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
      });
      // The provider disappears after the initial webhook check but before the
      // refund attempt. The refund stays retryable when no fallback resolves.
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        async () => {
          await settings.update.setPaymentProviderNone();
          await settings.update.stripe.secretKey("");
          await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
          settings.invalidateCache();
          await settings.loadKeys(ALL_SETTINGS_KEYS);
          return { listing: event, valid: true as const };
        },
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
