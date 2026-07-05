import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { setSuppressDebugLogs } from "#shared/logger.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv("server webhooks > refund logging", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("tryRefund logs success message when refund succeeds", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    await deactivateTestListing(listing.id);

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                amount_total: 1000,
                id: "cs_refund_log",
                metadata: signedMeta(
                  {
                    email: "refundlog@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "Refund Log",
                  },
                  1000,
                ),
                payment_intent: "pi_refund_log",
                payment_status: "paid",
              },
            },
            id: "evt_refund_log",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    const mockRefund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_log" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );

    const debugLogs: string[] = [];
    const origDebug = console.debug;
    setSuppressDebugLogs(false);
    console.debug = (...args: unknown[]) => {
      debugLogs.push(args.join(" "));
    };

    try {
      const response = await handleRequest(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);
      expect(mockRefund.calls[0]!.args).toEqual(["pi_refund_log"]);

      // Verify refund success was logged to console
      const refundLog = debugLogs.find((log) => log.includes("Refund issued"));
      expect(refundLog).toBeDefined();

      // Verify refund was logged to activity log tagged to listing
      const { getListingActivityLog } = await import("#test-utils");
      const entries = await getListingActivityLog(listing.id);
      const refundEntry = entries.find((e) =>
        e.message.includes("Automatic refund"),
      );
      expect(refundEntry).toBeDefined();
      expect(refundEntry!.listing_id).toBe(listing.id);
      expect(refundEntry!.message).toContain(
        "no longer accepting registrations",
      );
    } finally {
      console.debug = origDebug;
      setSuppressDebugLogs(null);
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

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          listing: {
            data: {
              object: {
                amount_total: 500,
                id: "cs_refund_activity",
                metadata: signedMeta(
                  {
                    email: "activity@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "Activity Log User",
                  },
                  500,
                ),
                payment_intent: "pi_refund_activity",
                payment_status: "paid",
              },
            },
            id: "evt_refund_activity",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    const mockRefund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_activity" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >),
    );

    try {
      const response = await handleRequest(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);

      const { getListingActivityLog } = await import("#test-utils");
      const entries = await getListingActivityLog(listing.id);
      const refundEntry = entries.find((e) =>
        e.message.includes("Automatic refund"),
      );
      expect(refundEntry).toBeDefined();
      expect(refundEntry!.listing_id).toBe(listing.id);
      expect(refundEntry!.message).toContain("price");
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });
});
