// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectKeptAsQuantityZeroAndRefunded,
  expectWebhookKeptAndRefunded,
  expectWebhookProcessed,
  mockRequest,
  setupStripe,
  signedMeta,
  signMeta,
  singleItem,
  stubRefundPayment,
  webhookMeta,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > single-ticket price-mismatch refunds",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("single-ticket is kept and refunded when price changed since checkout", async () => {
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

      // Signed by us, so the booking is kept as a quantity-0 placeholder (not
      // dropped) and refunded once, with a system note recording the reason.
      await expectKeptAsQuantityZeroAndRefunded(
        listing.id,
        "cs_mismatch",
        mockRefund,
      );

      // Verify refund was attempted exactly once
      expect(mockRefund.calls[0]!.args).toEqual(["pi_mismatch"]);
    });

    test("single-ticket redirect keeps the booking and shows the refund message when price changed", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // amountTotal (800) differs from expectedPrice (1000 * 1 = 1000)
      // Price decreased after checkout was created — should refund
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_redirect_mismatch",
          metadata: signMeta(
            webhookMeta({
              email: "redirect@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Redirect Mismatch",
            }),
            800,
          ),
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
        // A fully-handled outcome (booking kept, money returned) renders the
        // generic saved-details message with HTTP 200, not a retryable error
        // status. formatPaymentError appends the automatic-refund clause.
        await expectHtmlResponse(
          response,
          200,
          "saved your details",
          "refunded",
        );

        // Signed by us, so the booking is kept as a quantity-0 placeholder (not
        // dropped) and refunded once, with a system note recording the reason.
        await expectKeptAsQuantityZeroAndRefunded(
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

    test("webhook single-ticket defaults email to empty when metadata email is not a string", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_no_email_single",
          metadata: signedMeta(
            {
              email: 12345 as unknown as string, // not a string -> coerced to "" by extractSessionMetadata
              items: singleItem(listing.id, 1, 1000),
              name: "No Email Single",
            },
            1000,
          ),
          paymentIntent: "pi_wh_no_email_single",
          sessionId: "cs_wh_no_email_single",
        }),
      );

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });

    test("webhook multi-ticket defaults email to empty when metadata email is not a string", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 500,
      });

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_no_email_multi",
          metadata: signedMeta(
            {
              email: true as unknown as string, // not a string -> coerced to "" by extractSessionMetadata
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "No Email Multi",
            },
            500,
          ),
          paymentIntent: "pi_wh_no_email_multi",
          sessionId: "cs_wh_no_email_multi",
        }),
      );

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });
  },
);
