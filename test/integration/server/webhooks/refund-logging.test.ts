// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { settleDeferredPaymentWork } from "#test-utils/maintenance.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectRefundPaymentCall,
  stubRefundPayment,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/** Find the "Automatic refund" activity log entry for `listingId` and assert
 *  it's tagged to that listing — the shared lookup both refund-logging tests
 *  end with, before checking their own message substring. */
const findRefundActivityEntry = async (listingId: number) => {
  const { getListingActivityLog } = await import("#test-utils/activity-log.ts");
  const entries = await getListingActivityLog(listingId);
  const refundEntry = entries.find((e) =>
    e.message.includes("Automatic refund"),
  );
  expect(refundEntry).toBeDefined();
  expect(refundEntry!.listing_id).toBe(listingId);
  return refundEntry!;
};

describeWithEnv("server webhooks > refund logging", { db: true }, () => {
  test("records an automatic refund against the listing that caused it", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    await deactivateTestListing(listing.id);

    const mockVerify = await stubWebhookVerify(
      checkoutSessionEvent({
        amountTotal: 1000,
        eventId: "evt_refund_log",
        metadata: signedMeta(
          {
            email: "refundlog@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Refund Log",
          },
          1000,
        ),
        paymentIntent: "pi_refund_log",
        sessionId: "cs_refund_log",
      }),
    );

    const mockRefund = stubRefundPayment("re_log");

    try {
      const response = await handleRequest(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);
      // The refund and its activity entry are finished by maintenance.
      await settleDeferredPaymentWork();
      expectRefundPaymentCall(mockRefund, "pi_refund_log");

      // Verify refund was logged to activity log tagged to listing
      // The entry names why the money went back and that the booking stayed.
      const refundEntry = await findRefundActivityEntry(listing.id);
      expect(refundEntry.message).toContain("registration_closed");
      expect(refundEntry.message).toContain("kept at quantity 0");
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });

  test("automatic refund logs to activity log for price mismatch", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    const mockVerify = await stubWebhookVerify(
      checkoutSessionEvent({
        amountTotal: 500,
        eventId: "evt_refund_activity",
        metadata: signedMeta(
          {
            email: "activity@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Activity Log User",
          },
          500,
        ),
        paymentIntent: "pi_refund_activity",
        sessionId: "cs_refund_activity",
      }),
    );

    const mockRefund = stubRefundPayment("re_activity", 500);

    try {
      const response = await handleRequest(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);
      // The refund and its activity entry are finished by maintenance.
      await settleDeferredPaymentWork();

      const refundEntry = await findRefundActivityEntry(listing.id);
      expect(refundEntry.message).toContain("price");
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });
});
