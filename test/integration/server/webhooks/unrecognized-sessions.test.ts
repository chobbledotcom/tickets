// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { stripeApi } from "#shared/stripe.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookIgnored,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > unrecognized sessions", { db: true }, () => {
  test("webhook ignores session with no _origin marker", async () => {
    await setupStripe();

    const mockRefund = spy(stripeApi, "refundCharge");

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

    const mockRefund = spy(stripeApi, "refundCharge");

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

  test("webhook ignores a signed session whose booking will not read back", async () => {
    await setupStripe();

    const mockRefund = spy(stripeApi, "refundCharge");

    // The proof is ours, but the modifiers came back as an object instead of a
    // list. Booking cannot act on that, so nothing is booked with values
    // nobody has checked, and nothing is given back on a reading we cannot
    // trust — but the buyer HAS been charged, so the owner is told.
    await expectWebhookIgnored(
      checkoutSessionEvent({
        amountTotal: 500,
        eventId: "evt_unreadable_booking",
        metadata: signedMeta(
          {
            email: "unreadable@example.com",
            items: singleItem(1, 1, 500),
            modifiers: "{}",
            name: "Unreadable Booking",
          },
          500,
        ),
        paymentIntent: "pi_unreadable_booking",
        sessionId: "cs_unreadable_booking",
      }),
      () => {
        mockRefund.restore();
      },
    );
    expect(mockRefund.calls.length).toBe(0);
    // Silence here would leave a charged buyer with nothing and nobody
    // looking, which is the whole difference from a checkout that is not ours.
    const log = await getAllActivityLog();
    expect(
      log.some((entry) =>
        entry.message.includes(
          "Signed session's booking could not be read (session=cs_unreadable_booking)",
        ),
      ),
    ).toBe(true);
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
          currency: "GBP",
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

    const mockRefund = spy(stripeApi, "refundCharge");

    await expectWebhookIgnored(
      checkoutSessionEvent({
        amountTotal: 100,
        eventId: "evt_fallback_foreign",
        metadata: {},
        paymentIntent: "pi_fallback_foreign",
        sessionId: "cs_fallback_foreign",
      }),
      () => {
        mockRetrieveSession.restore();
        mockRefund.restore();
      },
    );
    expect(mockRefund.calls.length).toBe(0);
  });
});
