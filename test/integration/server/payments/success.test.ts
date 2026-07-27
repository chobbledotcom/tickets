// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { fillSoldOutListing } from "#test/integration/server/payments/_shared-setup.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { mockRequest, withMocks } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectRefundedWithNote,
  expectRefundPaymentCall,
  expectSessionFailed,
  expectUnreadableSessionRejected,
  expectUnrecognisedPayment,
  findKeptPlaceholder,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("GET /payment/success", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      await expectHtmlResponse(
        response,
        400,
        t("payment.error.invalid_callback"),
      );
    });

    test("returns error when no provider configured", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      await expectHtmlResponse(
        response,
        400,
        t("payment.error.provider_not_configured"),
      );
    });

    test("returns error when session not found", async () => {
      await setupStripe();
      // When session ID doesn't exist in Stripe, retrieveCheckoutSession returns null
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      await expectUnrecognisedPayment(response);
    });

    test("returns error when payment not verified", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          stubRetrieveCheckoutSession({
            amountTotal: 0,
            metadata: {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            },
            paymentIntent: "pi_test",
            paymentStatus: "unpaid",
            sessionId: "cs_test",
          }),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          await expectUnrecognisedPayment(response);
        },
      );
    });

    test("returns error for invalid session metadata", async () => {
      await setupStripe();
      await expectUnreadableSessionRejected("/payment/success", "cs_test");
    });

    /** Confirm a paid checkout the listing can no longer take: the buyer is
     *  told their details were saved and their money returned, and the refund
     *  goes out once against the payment named here. `body` continues with
     *  whatever else the scenario proves. */
    const expectConfirmationRefunded = async (
      buyer: { email: string; name: string },
      listingId: number,
      paymentIntent: string,
      body: (mockRefund: ReturnType<typeof stubRefundPayment>) => Promise<void>,
    ): Promise<void> => {
      await withMocks(
        () => ({
          mockRefund: stubRefundPayment(),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 1000,
            email: buyer.email,
            items: singleItem(listingId, 1, 1000),
            name: buyer.name,
            paymentIntent,
            sessionId: "cs_test",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          await expectHtmlResponse(
            response,
            200,
            "saved your details",
            "automatically refunded",
          );
          expect(mockRefund.calls.length).toBe(1);
          expectRefundPaymentCall(mockRefund, paymentIntent);
          await body(mockRefund);
        },
      );
    };

    test("rejects payment for inactive listing and refunds", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Deactivate the listing
      await deactivateTestListing(listing.id);

      await expectConfirmationRefunded(
        { email: "john@example.com", name: "John" },
        listing.id,
        "pi_test_123",
        () => Promise.resolve(),
      );
    });

    test("refunds payment when listing is sold out at confirmation time", async () => {
      // A sold-out listing: confirmation must refund because no spot remains.
      const listing = await fillSoldOutListing();

      await expectConfirmationRefunded(
        { email: "second@example.com", name: "Second" },
        listing.id,
        "pi_second",
        async (mockRefund) => {
          // The placeholder is kept alongside the original (sold-out) attendee,
          // with a system note recording the reason, and the session is filed
          // as a terminal failure (placeholder kept, no ticket attendee).
          const placeholder = await findKeptPlaceholder(listing.id);
          await expectRefundedWithNote(placeholder.id, mockRefund);
          await expectSessionFailed("cs_test");
        },
      );
    });
  });
});
