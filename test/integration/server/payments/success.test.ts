// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  attendeeExists,
  insertOrphanAttendee,
} from "#test/shared/db/prune/helpers.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { mockRequest, withMocks } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectNoRefundPlaceholder,
  expectRefundedWithoutAttendee,
  expectSessionFailed,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";
import { fillSoldOutListing } from "./_shared-setup.ts";

// jscpd:ignore-end

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("GET /payment/success", () => {
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

    test("closes and purges a staged checkout after a failed provider return", async () => {
      await setupStripe();
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendeeId = await insertOrphanAttendee(new Date().toISOString());
      await insertCheckoutStage(attendeeId, "cs_failed_stage");

      await withMocks(
        () => ({
          close: stub(stripePaymentProvider, "closeCheckout", () =>
            Promise.resolve("closed" as const),
          ),
          retrieve: stubRetrieveCheckoutSession({
            amountTotal: 0,
            metadata: {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            },
            paymentIntent: null,
            paymentStatus: "failed",
            sessionId: "cs_failed_stage",
          }),
        }),
        async ({ close }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_failed_stage"),
          );
          expect(response.status).toBe(200);
          expect(close.calls.length).toBe(1);
          expect(close.calls[0]!.args).toEqual([
            {
              providerCheckoutId: "cs_failed_stage",
              sessionId: "cs_failed_stage",
            },
          ]);
          expect(await attendeeExists(attendeeId)).toBe(false);
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
          // The signed checkout is refunded and its staged attendee is removed.
          // The customer sees the handled refund message with HTTP 200.
          await expectHtmlResponse(
            response,
            200,
            "couldn't complete your booking",
            "automatically refunded",
          );

          // Verify exactly one refund was issued, for the right intent.
          expect(mockRefund.calls.length).toBe(1);
          expect(mockRefund.calls[0]!.args).toEqual(["pi_second"]);

          // No staged attendee remains beside the sold-out booking. The terminal
          // failure remains so later deliveries replay the same result.
          await expectNoRefundPlaceholder(listing.id);
          await expectRefundedWithoutAttendee(mockRefund);
          await expectSessionFailed("cs_test");
        },
      );
    });
  });
});
