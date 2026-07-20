// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  signedMeta,
  signMeta,
  singleItem,
  webhookMeta,
} from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectStagedAttendeeRemovedAndRefunded,
  expectWebhookIgnored,
  expectWebhookKeptAndRefunded,
  stubRefundPayment,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > single-ticket price-mismatch refunds",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("single-ticket is removed and refunded when price changed since checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // amountTotal (1200) differs from expectedPrice (1000 * 1 = 1000)
      // Price changed after checkout was created — should refund
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1200,
          eventId: "evt_mismatch",
          metadata: signedMeta(
            {
              email: "mismatch@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Mismatch User",
            },
            1200,
          ),
          paymentIntent: "pi_mismatch",
          sessionId: "cs_mismatch",
        }),
        "re_mismatch",
      );

      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_mismatch",
        mockRefund,
      );

      // Verify refund was attempted exactly once
      expect(mockRefund.calls[0]!.args).toEqual(["pi_mismatch"]);
    });

    test("single-ticket redirect removes the stage and shows the refund message when price changed", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // amountTotal (800) differs from expectedPrice (1000 * 1 = 1000)
      // Price decreased after checkout was created — should refund
      const metadata = signMeta(
        webhookMeta({
          email: "redirect@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Redirect Mismatch",
        }),
        800,
      );
      const { stagePaymentCallback } = await import(
        "#test-utils/staged-payments.ts"
      );
      await stagePaymentCallback({
        amountTotal: 800,
        metadata,
        paymentReference: "pi_redirect_mismatch",
        sessionId: "cs_redirect_mismatch",
      });
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_redirect_mismatch",
          metadata,
          payment_intent: "pi_redirect_mismatch",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stubRefundPayment("re_redirect");

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_redirect_mismatch"),
        );
        // A fully-handled outcome (stage removed, money returned) renders the
        // generic saved-details message with HTTP 200, not a retryable error
        // status. formatPaymentError appends the automatic-refund clause.
        await expectHtmlResponse(
          response,
          200,
          "couldn't complete your booking",
          "refunded",
        );

        // The redirect removes the staged attendee and refunds the payment once.
        await expectStagedAttendeeRemovedAndRefunded(
          listing.id,
          "cs_redirect_mismatch",
          mockRefund,
        );

        // Verify refund was attempted exactly once
        expect(mockRefund.calls[0]!.args).toEqual(["pi_redirect_mismatch"]);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("webhook does not fulfil a session with non-text metadata", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_no_email_single",
          metadata: signedMeta(
            {
              email: 12345 as unknown as string,
              items: singleItem(listing.id, 1, 1000),
              name: "No Email Single",
            },
            1000,
          ),
          paymentIntent: "pi_wh_no_email_single",
          sessionId: "cs_wh_no_email_single",
        }),
      );

      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toEqual([]);
    });
  },
);
