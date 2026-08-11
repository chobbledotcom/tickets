// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import {
  mockRequest,
  mockWebhookRequest,
  withMocks,
} from "#test-utils/mocks.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
} from "#test-utils/payment-state.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectWebhookKeptAndRefunded,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks/stripe.ts";
import {
  checkoutSessionEvent,
  expectAttendeeCreatedWithPiiBlob,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/**
 * Turning new sales off (saving the payment provider as "none") must only stop
 * buyers starting NEW payments. Payments that already exist — a captured
 * charge that still has to be refunded, replayed provider callbacks, an
 * in-flight checkout that completes after the switch, and operator refunds —
 * keep running against the provider that captured them. Its credentials stay
 * stored, so the last provider the operator activated is reused.
 */
describeWithEnv(
  "server (payments) > existing payments stay live when new sales are off",
  { db: true, triggers: true },
  () => {
    /** Configure Stripe, then switch new sales off. Stripe's credentials and
     * webhook secret remain stored, so existing-payment work can still resolve
     * the Stripe provider that captured the money. */
    const salesOffAfterStripe = async (): Promise<void> => {
      await setupStripe();
      await settings.update.setPaymentProviderNone();
    };

    describe("replayed callbacks and completion", () => {
      test("a captured payment that needs refunding is still refunded", async () => {
        await salesOffAfterStripe();
        const listing = await createTestListing({
          maxAttendees: 50,
          unitPrice: 1000,
        });
        await deactivateTestListing(listing.id);

        const { mockRefund } = await expectWebhookKeptAndRefunded(
          checkoutSessionEvent({
            amountTotal: 1000,
            eventId: "evt_off_refund",
            metadata: signedMeta(
              {
                email: "refund-off@example.com",
                items: singleItem(listing.id, 1, 1000),
                name: "Refund Off",
              },
              1000,
            ),
            paymentIntent: "pi_off_refund",
            sessionId: "cs_off_refund",
          }),
          "re_off_refund",
          "no longer accepting registrations",
        );
        expect(mockRefund.calls.length).toBe(1);
      });

      test("an in-flight payment completes and issues the ticket", async () => {
        await salesOffAfterStripe();
        const listing = await createTestListing({
          maxAttendees: 50,
          unitPrice: 1000,
        });

        const { stripePaymentProvider } = await import(
          "#shared/stripe-provider.ts"
        );
        using _mockVerify = stub(
          stripePaymentProvider,
          "verifyWebhookSignature",
          () =>
            Promise.resolve({
              listing: checkoutSessionEvent({
                amountTotal: 1000,
                eventId: "evt_off_complete",
                metadata: signedMeta(
                  {
                    email: "complete-off@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "Complete Off",
                  },
                  1000,
                ),
                paymentIntent: "pi_off_complete",
                sessionId: "cs_off_complete",
              }),
              valid: true as const,
            }),
        );
        const response = await handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        );
        expect(response.status).toBe(200);
        const json = (await response.json()) as Record<string, unknown>;
        expect(json.processed).toBe(true);
        await expectAttendeeCreatedWithPiiBlob(listing.id);
      });

      test("a handled failure replays the same outcome on a redelivered callback", async () => {
        await setupStripe();
        const listing = await createTestListing({
          maxAttendees: 50,
          unitPrice: 1000,
        });
        await deactivateTestListing(listing.id);

        await withMocks(
          () => ({
            mockRefund: stubRefundPayment(),
            mockRetrieve: stubRetrieveCheckoutSession({
              amountTotal: 1000,
              email: "replay-off@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Replay Off",
              paymentIntent: "pi_off_replay",
              sessionId: "cs_off_replay",
            }),
          }),
          async ({ mockRefund }) => {
            const first = await handleRequest(
              mockRequest("/payment/success?session_id=cs_off_replay"),
            );
            await expectHtmlResponse(
              first,
              410,
              "no longer accepting registrations",
              "refunded",
            );
            expect(mockRefund.calls.length).toBe(1);

            // New sales switched off AFTER the first delivery captured the
            // handled outcome. The redelivery must replay it, not 400 on a
            // missing provider.
            await settings.update.setPaymentProviderNone();

            const second = await handleRequest(
              mockRequest("/payment/success?session_id=cs_off_replay"),
            );
            const html = await expectHtmlResponse(
              second,
              410,
              "no longer accepting registrations",
              "refunded",
            );
            expect(html).not.toContain("being processed");
            expect(html).not.toContain("not configured");
            expect(mockRefund.calls.length).toBe(1);
          },
        );
      });
    });

    describe("refunds and provider outages", () => {
      test("an operator can refund an existing paid booking", async () => {
        await setupStripe();
        const { setupRefundTest } = await import(
          "#test/features/admin/refunds-helpers.ts"
        );
        const { submitRefund } = await import("#test-utils/refund-routes.ts");
        const ctx = await setupRefundTest("pi_off_admin");
        // New sales off, but the Stripe provider (and its key) remain stored.
        await settings.update.setPaymentProviderNone();
        const { stripePaymentProvider } = await import(
          "#shared/stripe-provider.ts"
        );
        using _read = stub(stripePaymentProvider, "readCharge", () =>
          Promise.resolve(foundCharge(chargeMoney())),
        );
        using mockRefund = stub(
          stripePaymentProvider,
          "refundCharge",
          (request: RefundRequest) =>
            Promise.resolve(completedRefund(request.charge)),
        );
        const response = await submitRefund(ctx);
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/actions`,
          "Refund issued",
        )(response);
        expect(mockRefund.calls.length).toBe(1);
      });
    });
  },
);
