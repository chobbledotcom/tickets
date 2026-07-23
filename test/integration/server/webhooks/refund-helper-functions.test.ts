// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectAttendeeCreatedWithPiiBlob,
  expectSessionFailed,
  expectWebhookProcessed,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > refund helper functions",
  { db: true },
  () => {
    test("missing terminal payment records fail loudly", async () => {
      await expect(expectSessionFailed("missing-session")).rejects.toThrow(
        "Processed payment missing-session was not stored",
      );
    });

    test("tryRefund returns false when paymentReference is empty", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      await deactivateTestListing(listing.id);

      const mockRetrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        email: "john@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "John",
        paymentIntent: null, // No payment reference
        sessionId: "cs_null_ref",
      });

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_null_ref"),
        );
        const html = await expectHtmlResponse(
          response,
          400,
          "Payment session not found",
        );
        expect(html).not.toContain("contact support");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("webhook extracts payment_intent as paymentReference", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_pi_extract",
          metadata: signedMeta(
            {
              email: "pi@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "PI User",
            },
            1000,
          ),
          paymentIntent: "pi_extracted_ref",
          sessionId: "cs_pi_extract",
        }),
      );

      await expectAttendeeCreatedWithPiiBlob(listing.id);
    });

    test("formatPaymentError returns plain error when refunded is undefined", async () => {
      await setupStripe();

      // This tests the case where result.refunded is undefined
      // This happens when validatePaidSession fails (no refund attempt)
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_plain_error",
          metadata: {
            email: "john@example.com",
            items: singleItem(1, 1, 0),
            name: "John",
          },
          payment_intent: "pi_test",
          payment_status: "unpaid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_plain_error"),
        );
        const html = await expectHtmlResponse(
          response,
          400,
          "Payment verification failed",
        );
        // Should NOT contain refund-related text
        expect(html).not.toContain("refunded");
        expect(html).not.toContain("contact support for a refund");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("webhook cancel page returns error when no provider", async () => {
      // Don't set up any payment provider
      const response = await handleRequest(
        mockRequest("/payment/cancel?session_id=cs_cancel_no_prov"),
      );
      await expectHtmlResponse(
        response,
        400,
        "Payment provider not configured",
      );
    });

    test("a real create error propagates instead of refunding", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Create Boom",
        unitPrice: 500,
      });
      const mockRetrieve = stubRetrieveCheckoutSession({
        amountTotal: 500,
        email: "boom@example.com",
        items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
        name: "Boom",
        paymentIntent: "pi_create_boom",
        sessionId: "cs_create_boom",
      });
      const mockRefund = stubRefundPayment();
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
      // The booking honour path uses createBookingAtomic; the quantity-0
      // placeholder fallback uses createAttendeeAtomic. A genuinely broken
      // create breaks both, so the error escapes instead of becoming a refund.
      const mockBooking = stub(attendeesApi, "createBookingAtomic", () =>
        Promise.reject(new Error("synthetic create failure")),
      );
      const mockAtomic = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.reject(new Error("synthetic create failure")),
      );
      using _env = withEnv({ TEST_EXPECT_ERROR: undefined });
      try {
        // A non-sold-out error is not swallowed as a refund: it propagates.
        await expect(
          handleRequest(
            mockRequest("/payment/success?session_id=cs_create_boom"),
          ),
        ).rejects.toThrow("synthetic create failure");
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
        mockBooking.restore();
        mockAtomic.restore();
      }
    });

    test("multi-ticket no firstAttendee returns refund error", async () => {
      await setupStripe();

      // Mock empty items list (edge case where items parsed but empty after filtering)
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_empty_items",
          metadata: {
            email: "empty@example.com",
            items: "[]", // Empty array
            name: "Empty Items",
          },
          payment_intent: "pi_multi_empty",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stubRefundPayment();

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_empty_items"),
        );
        // Empty items list returns "Invalid cart session data"
        expect(response.status).toBe(400);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });
  },
);
