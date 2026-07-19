// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
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
  expectSessionFailed,
  findKeptPlaceholder,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";
import { fillSoldOutListing } from "../../../lib/server-payments/_shared-setup.ts";

// jscpd:ignore-end

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("GET /payment/success", () => {
    // Some tests here configure Stripe without installing mocks (so no
    // withMocks cleanup runs); reset the client after each so configuration
    // never leaks into the next test.

    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      await expectHtmlResponse(response, 400, "Invalid payment callback");
    });

    test("returns error when no provider configured", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      await expectHtmlResponse(
        response,
        400,
        "Payment provider not configured",
      );
    });

    test("returns error when session not found", async () => {
      await setupStripe();
      // When session ID doesn't exist in Stripe, retrieveCheckoutSession returns null
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      await expectHtmlResponse(response, 400, "Payment session not found");
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
          await expectHtmlResponse(
            response,
            400,
            "Payment verification failed",
          );
        },
      );
    });

    test("returns error for invalid session metadata", async () => {
      await setupStripe();

      await withMocks(
        () =>
          stubRetrieveCheckoutSession({
            amountTotal: 0,
            metadata: {}, // Missing required fields
            paymentIntent: "pi_test",
            sessionId: "cs_test",
          }),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          // Provider returns null for invalid metadata, so routes report "not found"
          await expectHtmlResponse(response, 400, "Payment session not found");
        },
      );
    });

    test("rejects payment for inactive listing and refunds", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Deactivate the listing
      await deactivateTestListing(listing.id);

      await withMocks(
        () => ({
          mockRefund: stubRefundPayment(),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 1000,
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
            paymentIntent: "pi_test_123",
            sessionId: "cs_test",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          await expectHtmlResponse(
            response,
            410,
            "no longer accepting registrations",
          );

          // Verify exactly one refund was issued, for the right intent.
          expect(mockRefund.calls.length).toBe(1);
          expect(mockRefund.calls[0]!.args).toEqual(["pi_test_123"]);
        },
      );
    });

    test("refunds payment when listing is sold out at confirmation time", async () => {
      // A sold-out listing: confirmation must refund because no spot remains.
      const listing = await fillSoldOutListing();

      await withMocks(
        () => ({
          mockRefund: stubRefundPayment(),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 1000,
            email: "second@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Second",
            paymentIntent: "pi_second",
            sessionId: "cs_test",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          // Signed by us → the late buyer is not dropped: the booking is kept as
          // a quantity-0 placeholder and refunded, and the customer sees the
          // generic saved-details message (HTTP 200, a fully-handled outcome).
          await expectHtmlResponse(
            response,
            200,
            "saved your details",
            "automatically refunded",
          );

          // Verify exactly one refund was issued, for the right intent.
          expect(mockRefund.calls.length).toBe(1);
          expect(mockRefund.calls[0]!.args).toEqual(["pi_second"]);

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
