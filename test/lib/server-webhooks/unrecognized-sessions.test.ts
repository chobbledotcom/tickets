import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  singleItem,
  webhookMeta,
} from "#test-utils";

describeWithEnv("server webhooks > unrecognized sessions", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("webhook ignores session with no _origin marker", async () => {
    await setupStripe();

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
                amount_total: 30,
                id: "cs_foreign",
                metadata: {
                  email: "foreign@example.com",
                  items: singleItem(1, 1, 0),
                  name: "Foreign Buyer",
                },
                payment_intent: "pi_foreign",
                payment_status: "paid",
              },
            },
            id: "evt_foreign",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    const mockRefund = spy(stripeApi, "refundPayment");

    try {
      // Returns 200 to prevent provider retries
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.received).toBe(true);
          // Should not attempt to process or refund
          expect(json.processed).toBeUndefined();
        },
      );
      expect(mockRefund.calls.length).toBe(0);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });

  test("webhook ignores session with wrong _origin marker", async () => {
    await setupStripe();

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
                id: "cs_other_instance",
                metadata: {
                  _origin: "other-domain.com",
                  email: "other@example.com",
                  items: singleItem(1, 1, 500),
                  name: "Other Instance",
                },
                payment_intent: "pi_other_instance",
                payment_status: "paid",
              },
            },
            id: "evt_other_instance",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    const mockRefund = spy(stripeApi, "refundPayment");

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.received).toBe(true);
          expect(json.processed).toBeUndefined();
        },
      );
      expect(mockRefund.calls.length).toBe(0);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });

  test("webhook ignores unrecognized session via fallback retrieval path", async () => {
    await setupStripe();

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
                id: "cs_fallback_foreign",
                status: "COMPLETED",
                // No proper metadata -> extractSessionFromListing returns null
              },
            },
            id: "evt_fallback_foreign",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    const mockRetrieveSession = stub(
      stripePaymentProvider,
      "retrieveSession",
      () =>
        Promise.resolve({
          amountTotal: 100,
          id: "cs_fallback_foreign",
          metadata: webhookMeta({
            _origin: "", // Empty _origin -> should be rejected as unrecognized
            email: "fallback@example.com",
            name: "Fallback Foreign",
          }),
          paymentReference: "pi_fallback_foreign",
          paymentStatus: "paid" as const,
        }),
    );

    const mockRefund = spy(stripeApi, "refundPayment");

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.received).toBe(true);
          expect(json.processed).toBeUndefined();
        },
      );
      expect(mockRefund.calls.length).toBe(0);
    } finally {
      mockVerify.restore();
      mockRetrieveSession.restore();
      mockRefund.restore();
    }
  });
});
