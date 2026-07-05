// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  describeWithEnv,
  expectWebhookIgnored,
  setupStripe,
  singleItem,
  webhookMeta,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("server webhooks > unrecognized sessions", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("webhook ignores session with no _origin marker", async () => {
    await setupStripe();

    const mockRefund = spy(stripeApi, "refundPayment");

    // Returns 200 to prevent provider retries; should not attempt to process
    // or refund.
    await expectWebhookIgnored(
      checkoutSessionEvent({
        amountTotal: 30,
        eventId: "evt_foreign",
        metadata: {
          email: "foreign@example.com",
          items: singleItem(1, 1, 0),
          name: "Foreign Buyer",
        },
        paymentIntent: "pi_foreign",
        sessionId: "cs_foreign",
      }),
      () => {
        mockRefund.restore();
      },
    );
    expect(mockRefund.calls.length).toBe(0);
  });

  test("webhook ignores session with wrong _origin marker", async () => {
    await setupStripe();

    const mockRefund = spy(stripeApi, "refundPayment");

    await expectWebhookIgnored(
      checkoutSessionEvent({
        amountTotal: 500,
        eventId: "evt_other_instance",
        metadata: {
          _origin: "other-domain.com",
          email: "other@example.com",
          items: singleItem(1, 1, 500),
          name: "Other Instance",
        },
        paymentIntent: "pi_other_instance",
        sessionId: "cs_other_instance",
      }),
      () => {
        mockRefund.restore();
      },
    );
    expect(mockRefund.calls.length).toBe(0);
  });

  test("webhook ignores unrecognized session via fallback retrieval path", async () => {
    await setupStripe();

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
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

    await expectWebhookIgnored(
      {
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
      () => {
        mockRetrieveSession.restore();
        mockRefund.restore();
      },
    );
    expect(mockRefund.calls.length).toBe(0);
  });
});
