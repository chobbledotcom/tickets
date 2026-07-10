// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  bookAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectRefundedWithNote,
  expectSessionFailed,
  findKeptPlaceholder,
  mockRequest,
  setupStripe,
  singleItem,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
  withMocks,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("GET /payment/success", () => {
    // Some tests here configure Stripe without installing mocks (so no
    // withMocks cleanup runs); reset the client after each so configuration
    // never leaks into the next test.
    afterEach(() => {
      resetStripeClient();
    });

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
        resetStripeClient,
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
        resetStripeClient,
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

          // Verify refund was called
          expect(mockRefund.calls[0]!.args).toEqual(["pi_test_123"]);
        },
        resetStripeClient,
      );
    });

    test("refunds payment when listing is sold out at confirmation time", async () => {
      await setupStripe();

      // Create listing with only 1 spot
      const listing = await createTestListing({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Fill the listing with another attendee (using atomic to simulate production flow)
      await bookAttendee(listing, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

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

          // Verify refund was called once
          expect(mockRefund.calls[0]!.args).toEqual(["pi_second"]);
          expect(mockRefund.calls.length).toBe(1);

          // The placeholder is kept alongside the original (sold-out) attendee,
          // with a system note recording the reason, and the session is filed
          // as a terminal failure (placeholder kept, no ticket attendee).
          const placeholder = await findKeptPlaceholder(listing.id);
          await expectRefundedWithNote(placeholder.id, mockRefund);
          await expectSessionFailed("cs_test");
        },
        resetStripeClient,
      );
    });
  });
});
