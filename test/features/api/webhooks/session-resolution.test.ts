// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  attendeeExists,
  insertOrphanAttendee,
} from "#test/shared/db/prune/helpers.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stagePaymentCallback } from "#test-utils/staged-payments.ts";
import {
  checkoutSessionEvent,
  expectAttendeeWithPricePaid,
  expectWebhookIgnored,
  expectWebhookPending,
  expectWebhookProcessed,
  postWebhookAndAssert,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > session resolution", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
    setSuppressDebugLogs(null);
  });

  test("webhook with checkout listing type but no extractable session acknowledges without processing", async () => {
    await setupStripe();

    // Listing type matches checkoutCompletedEventType but data lacks metadata
    // so extractSessionFromListing returns null (covers lines 498-500)
    // and data object has no id/order_id so sessionId is null (covers lines 597-602)
    // Returns 200 to prevent provider retries
    await expectWebhookIgnored({
      data: {
        object: {
          // No id, no order_id, no proper metadata
          some_field: "value",
        },
      },
      id: "evt_no_extract",
      type: "checkout.session.completed",
    });
  });

  test("webhook returns pending when resolveWebhookSession returns skip", async () => {
    await setupStripe();

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve("skip" as const),
    );

    await expectWebhookPending(
      {
        data: { object: {} },
        id: "evt_skip",
        type: "checkout.session.completed",
      },
      () => {
        mockResolve.restore();
      },
    );
  });

  test("webhook requests provider retry when session resolution is temporary", async () => {
    await setupStripe();
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve("retry" as const),
    );
    const mockVerify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_retry",
      type: "checkout.session.completed",
    });
    try {
      await postWebhookAndAssert(
        () => {},
        503,
        (json) => expect(json).toEqual({ status: "retry" }),
      );
    } finally {
      mockVerify.restore();
      mockResolve.restore();
    }
  });

  test("an authenticated Stripe expiry closes and purges its staged checkout", async () => {
    await setupStripe();
    const attendeeId = await insertOrphanAttendee(new Date().toISOString());
    await insertCheckoutStage(attendeeId, "cs_expired", {
      createdAt: new Date().toISOString(),
    });
    const close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("closed" as const),
    );
    try {
      await expectWebhookIgnored({
        data: {
          object: {
            amount_total: 0,
            id: "cs_expired",
            metadata: { email: "e@example.com", items: "[]", name: "E" },
            payment_status: "unpaid",
          },
        },
        id: "evt_expired",
        type: "checkout.session.expired",
      });
      expect(close.calls.length).toBe(1);
      expect(await attendeeExists(attendeeId)).toBe(false);
    } finally {
      close.restore();
    }
  });

  test("an expiry close failure keeps the stage for scheduled retry", async () => {
    await setupStripe();
    const attendeeId = await insertOrphanAttendee(new Date().toISOString());
    await insertCheckoutStage(attendeeId, "cs_expiry_retry", {
      createdAt: new Date().toISOString(),
    });
    const close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.reject(new Error("Stripe unavailable")),
    );
    try {
      const verify = await stubWebhookVerify({
        data: {
          object: {
            amount_total: 0,
            id: "cs_expiry_retry",
            metadata: { email: "e@example.com", items: "[]", name: "E" },
            payment_status: "unpaid",
          },
        },
        id: "evt_expiry_retry",
        type: "checkout.session.expired",
      });
      try {
        await postWebhookAndAssert(
          () => {},
          503,
          (json) => expect(json).toEqual({ status: "retry" }),
        );
      } finally {
        verify.restore();
      }
      expect(close.calls.length).toBe(1);
      expect(await attendeeExists(attendeeId)).toBe(true);
      expect(
        await loadCheckoutStageByPaymentSession("cs_expiry_retry"),
      ).toMatchObject({
        attendeeId,
        paymentSessionId: "cs_expiry_retry",
        state: "pending",
      });
    } finally {
      close.restore();
    }
  });

  test("an expiry that becomes paid while closing processes the refreshed payment", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const metadata = signedMeta(
      {
        email: "race@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Race winner",
      },
      1000,
    );
    await stagePaymentCallback({
      amountTotal: 1000,
      metadata,
      paymentReference: "pi_expiry_paid",
      sessionId: "cs_expiry_paid",
    });
    const close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("paid" as const),
    );
    const retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
      Promise.resolve({
        amountTotal: 1000,
        id: "cs_expiry_paid",
        metadata,
        paymentReference: "pi_expiry_paid",
        paymentStatus: "paid" as const,
      }),
    );
    const verify = await stubWebhookVerify({
      data: {
        object: {
          amount_total: 1000,
          id: "cs_expiry_paid",
          metadata,
          payment_status: "unpaid",
        },
      },
      id: "evt_expiry_paid",
      type: "checkout.session.expired",
    });
    try {
      await postWebhookAndAssert(
        () => {},
        200,
        (json) => expect(json).toEqual({ processed: true, received: true }),
      );
      expect(close.calls.length).toBe(1);
      expect(retrieve.calls.length).toBe(1);
      await expectAttendeeWithPricePaid(listing.id, 1000);
    } finally {
      verify.restore();
      retrieve.restore();
      close.restore();
    }
  });

  test("an expiry paid race retries until the paid session is readable", async () => {
    await setupStripe();
    const attendeeId = await insertOrphanAttendee(new Date().toISOString());
    await insertCheckoutStage(attendeeId, "cs_expiry_paid_retry");
    const close = stub(stripePaymentProvider, "closeCheckout", () =>
      Promise.resolve("paid" as const),
    );
    const retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
      Promise.resolve(null),
    );
    const verify = await stubWebhookVerify({
      data: {
        object: {
          amount_total: 0,
          id: "cs_expiry_paid_retry",
          metadata: { email: "e@example.com", items: "[]", name: "E" },
          payment_status: "unpaid",
        },
      },
      id: "evt_expiry_paid_retry",
      type: "checkout.session.expired",
    });
    try {
      await postWebhookAndAssert(
        () => {},
        503,
        (json) => expect(json).toEqual({ status: "retry" }),
      );
      expect(
        await loadCheckoutStageByPaymentSession("cs_expiry_paid_retry"),
      ).toMatchObject({ attendeeId, state: "pending" });
    } finally {
      verify.restore();
      retrieve.restore();
      close.restore();
    }
  });

  test("webhook acknowledges when resolveWebhookSession returns null", async () => {
    await setupStripe();

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockResolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve(null),
    );
    const debugLog = spy(console, "debug");
    setSuppressDebugLogs(false);

    try {
      await expectWebhookIgnored({
        data: { object: {} },
        id: "evt_null",
        type: "checkout.session.completed",
      });
      expect(
        debugLog.calls.map((call) => call.args.join(" ")).join("\n"),
      ).toContain("Ignoring webhook for unrecognized payment session:");
    } finally {
      debugLog.restore();
      mockResolve.restore();
    }
  });

  test("webhook treats invalid payment_status as unpaid", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    // "completed" is not a valid payment status, so paymentStatus defaults to "unpaid"
    // This means the session is treated as unpaid and returns a pending acknowledgement
    const errorLog = spy(console, "error");
    const debugLog = spy(console, "debug");
    setSuppressDebugLogs(false);
    try {
      await expectWebhookPending(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_bad_status",
          metadata: webhookMeta({
            email: "badstatus@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Bad Status",
          }),
          paymentIntent: "pi_bad_status",
          paymentStatus: "completed",
          sessionId: "cs_bad_status",
        }),
      );
      expect(
        errorLog.calls.map((call) => call.args.join(" ")).join("\n"),
      ).toContain(
        "Webhook session not yet paid (session=cs_bad_status, status=unpaid)",
      );
      expect(
        debugLog.calls.map((call) => call.args.join(" ")).join("\n"),
      ).toContain("Pending payload:");
    } finally {
      debugLog.restore();
      errorLog.restore();
    }
  });

  test("webhook extracts amount_total as number from listing data", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 2500,
    });

    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 2500,
        eventId: "evt_amount_total",
        metadata: signedMeta(
          {
            email: "amount@example.com",
            items: singleItem(listing.id, 1, 2500),
            name: "Amount User",
          },
          2500,
        ),
        paymentIntent: "pi_amount_total",
        sessionId: "cs_amount_total",
      }),
    );

    await expectAttendeeWithPricePaid(listing.id, 2500);
  });
});
