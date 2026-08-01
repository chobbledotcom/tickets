// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import {
  assertPublicHtml,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { johnCheckoutSession } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { mockRequest, withMocks } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/** A cancelled (unpaid) checkout session for the given id and items metadata —
 *  the shape every /payment/cancel test stubs, differing only in the id and
 *  which listing/package ids the items carry. */
const cancelSession = (sessionId: string, items: string) =>
  johnCheckoutSession(sessionId, { items, paid: false });

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("GET /payment/cancel", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/cancel"));
      await expectHtmlResponse(response, 400, "Invalid payment callback");
    });

    test("returns error when session not found", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      await withMocks(
        () =>
          stub(stripeApi, "retrieveCheckoutSession", () =>
            Promise.resolve(null),
          ),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_invalid"),
          );
          await expectHtmlResponse(response, 400, "Payment session not found");
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
            paymentIntent: null,
            paymentStatus: "unpaid",
            sessionId: "cs_test_cancel",
          }),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/cancel?session_id=cs_test_cancel"),
          );
          // Provider returns null for invalid metadata, so routes report "not found"
          await expectHtmlResponse(response, 400, "Payment session not found");
        },
      );
    });

    test("refunds and refuses a paid session the boundary could not read", async () => {
      await setupStripe();

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const refundSpy = spy(stripeApi, "refundPayment");
      try {
        await withMocks(
          () =>
            stub(stripePaymentProvider, "retrieveSession", () =>
              Promise.resolve({
                paymentReference: "pi_unusable",
                reason: "malformed_charge",
                refundable: true,
              }),
            ),
          async () => {
            const response = await handleRequest(
              mockRequest("/payment/cancel?session_id=cs_rejected"),
            );
            await expectHtmlResponse(
              response,
              400,
              "Payment session not found",
            );
          },
        );
        expect(refundSpy.calls.length).toBe(1);
        expect(refundSpy.calls[0]?.args[0]).toBe("pi_unusable");
      } finally {
        refundSpy.restore();
      }
    });

    // The page itself, and which page it offers to try again, are covered
    // directly in test/features/api/payment-processing/cancel.test.ts. This
    // one proves the route reaches it for a real checkout.
    test("renders the cancel page for a real checkout", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await withMocks(
        () => cancelSession("cs_test_cancel", singleItem(listing.id, 1, 1000)),
        async () => {
          await assertPublicHtml(
            "/payment/cancel?session_id=cs_test_cancel",
            "Payment Cancelled",
            `/ticket/${listing.slug}`,
          );
        },
      );
    });
  });
});
