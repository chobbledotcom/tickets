// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookIgnored,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > unrecognized sessions", { db: true }, () => {
  test("webhook ignores session with no _origin marker", async () => {
    await setupStripe();

    const mockRefund = spy(stripeApi, "requestRefund");

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

    const mockRefund = spy(stripeApi, "requestRefund");

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

  // An empty marker is as foreign as a wrong one — it proves nothing, so the
  // session is ignored rather than refunded.
  test("webhook ignores session with an empty _origin marker", async () => {
    await setupStripe();

    const mockRefund = spy(stripeApi, "requestRefund");

    await expectWebhookIgnored(
      checkoutSessionEvent({
        amountTotal: 100,
        eventId: "evt_fallback_foreign",
        metadata: {
          _origin: "",
          email: "fallback@example.com",
          items: singleItem(1, 1, 100),
          name: "Fallback Foreign",
        },
        paymentIntent: "pi_fallback_foreign",
        sessionId: "cs_fallback_foreign",
      }),
      () => {
        mockRefund.restore();
      },
    );
    expect(mockRefund.calls.length).toBe(0);
  });
});
