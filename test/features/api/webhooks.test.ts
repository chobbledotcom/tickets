import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { type SpyCall, spy, stub } from "@std/testing/mock";
import { handlePaymentWebhook, routePayment } from "#routes/api/webhooks.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";

/** Call the payment router with path/method extracted from the request. */
const routeRequest = (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  return routePayment(request, url.pathname, request.method);
};

/** Scoped console.error and console.debug spies — logError routes to
 * console.error and logDebug to console.debug, so asserting on both is how a
 * test proves a boundary log call ran (a removed call is otherwise
 * unobservable). */
const setupLogSpies = (): {
  errorContains: (needle: string) => boolean;
  debugContains: (needle: string) => boolean;
} => {
  let errorCalls: SpyCall[] = [];
  let debugCalls: SpyCall[] = [];
  // deno-lint-ignore no-explicit-any
  let errorSpy: any;
  // deno-lint-ignore no-explicit-any
  let debugSpy: any;
  beforeEach(() => {
    errorCalls = [];
    debugCalls = [];
    errorSpy = spy(console, "error");
    debugSpy = spy(console, "debug");
  });
  afterEach(() => {
    errorCalls = [...errorSpy.calls];
    debugCalls = [...debugSpy.calls];
    errorSpy.restore();
    debugSpy.restore();
  });
  return {
    errorContains: (needle: string) =>
      errorCalls.some((call) => String(call.args[0]).includes(needle)),
    debugContains: (needle: string) =>
      debugCalls.some((call) => String(call.args[0]).includes(needle)),
  };
};

describeWithEnv("payment webhook resolution", { db: true }, () => {
  const logs = setupLogSpies();

  test("requests provider retry when session resolution is temporary", async () => {
    await setupStripe();
    const resolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve("retry" as const),
    );
    const verify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_retry",
      type: "checkout.session.completed",
    });
    try {
      const response = await handlePaymentWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "retry" });
    } finally {
      verify.restore();
      resolve.restore();
    }
  });

  test("acknowledges skip sessions as pending", async () => {
    await setupStripe();
    const resolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve("skip" as const),
    );
    const verify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_skip",
      type: "checkout.session.completed",
    });
    try {
      const response = await handlePaymentWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, status: "pending" });
    } finally {
      verify.restore();
      resolve.restore();
    }
  });

  test("acknowledges unrecognized sessions without processing", async () => {
    await setupStripe();
    const resolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () => Promise.resolve(null),
    );
    const verify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_unknown",
      type: "checkout.session.completed",
    });
    try {
      const response = await handlePaymentWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
      expect(logs.debugContains("Ignoring webhook for unrecognized")).toBe(true);
    } finally {
      verify.restore();
      resolve.restore();
    }
  });

  test("acknowledges non-checkout event types without processing", async () => {
    await setupStripe();
    const verify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_other",
      type: "payment_intent.created",
    });
    try {
      const response = await handlePaymentWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
    } finally {
      verify.restore();
    }
  });

  test("returns 400 when no provider configured and logs rejection", async () => {
    const response = await handlePaymentWebhook(
      mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("Payment provider not configured");
    expect(logs.debugContains("Rejected payload")).toBe(true);
  });

  test("returns 400 when signature header missing and logs error", async () => {
    await setupStripe();
    const verify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_nosig",
      type: "checkout.session.completed",
    });
    try {
      const response = await handlePaymentWebhook(mockWebhookRequest({}));
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Missing signature");
      expect(logs.errorContains("Webhook missing signature header")).toBe(true);
      expect(logs.debugContains("Rejected payload")).toBe(true);
    } finally {
      verify.restore();
    }
  });

  test("returns 400 when signature verification fails and logs error", async () => {
    await setupStripe();
    const verify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () => Promise.resolve({ valid: false, error: "signature mismatch" }),
    );
    try {
      const response = await handlePaymentWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_bad" }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("signature mismatch");
      expect(logs.errorContains("signature verification failed")).toBe(true);
      expect(logs.debugContains("Rejected payload")).toBe(true);
    } finally {
      verify.restore();
    }
  });

  test("acknowledges unpaid checkout as pending and logs error", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const resolve = stub(
      stripePaymentProvider,
      "resolveWebhookSession",
      () =>
        Promise.resolve({
          amountTotal: 1000,
          id: "cs_unpaid",
          metadata: signedMeta(
            {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            },
            1000,
          ),
          paymentReference: "pi_test",
          paymentStatus: "unpaid",
        }),
    );
    const verify = await stubWebhookVerify({
      data: { object: {} },
      id: "evt_unpaid",
      type: "checkout.session.completed",
    });
    try {
      const response = await handlePaymentWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        received: true,
        status: "pending",
      });
      expect(logs.errorContains("Webhook session not yet paid")).toBe(true);
      expect(logs.debugContains("Pending payload")).toBe(true);
    } finally {
      verify.restore();
      resolve.restore();
    }
  });

  test("marks success page as paid for a processed redirect", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/thanks",
      unitPrice: 1000,
    });

    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_paid",
        metadata: signedMeta(
          {
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
            thank_you_url: "https://example.com/thanks",
          },
          1000,
        ),
        payment_intent: "pi_test",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const response = await routeRequest(
        mockRequest("/payment/success?session_id=cs_paid"),
      );
      const html = await (response ?? new Response()).text();
      expect(html).toContain('data-payment-result="success"');
    } finally {
      retrieve.restore();
    }
  });
});

describeWithEnv("payment callback params", { db: true }, () => {
  const logs = setupLogSpies();

  test("returns error for missing session_id on cancel and logs error", async () => {
    const response = await routeRequest(mockRequest("/payment/cancel"));
    expect((response ?? new Response()).status).toBe(400);
    const text = await (response ?? new Response()).text();
    expect(text).toContain("Invalid payment callback");
    expect(logs.errorContains("Payment callback missing session_id parameter")).toBe(true);
  });

  test("returns error for missing session_id on success and logs error", async () => {
    const response = await routeRequest(mockRequest("/payment/success"));
    expect((response ?? new Response()).status).toBe(400);
    const text = await (response ?? new Response()).text();
    expect(text).toContain("Invalid payment callback");
  });

  test("returns error for success with no session_id or tokens and logs error", async () => {
    const response = await routeRequest(
      mockRequest("/payment/success?foo=bar"),
    );
    expect((response ?? new Response()).status).toBe(400);
    expect(logs.errorContains("no session_id or tokens")).toBe(true);
  });

  test("cancel returns error when no provider configured and logs cancel error", async () => {
    const response = await routeRequest(
      mockRequest("/payment/cancel?session_id=cs_noprovider"),
    );
    expect((response ?? new Response()).status).toBe(400);
    const text = await (response ?? new Response()).text();
    expect(text).toContain("Payment provider not configured");
    expect(logs.errorContains("No provider configured")).toBe(true);
  });

  test("cancel returns error when session not found and logs cancel error", async () => {
    await setupStripe();
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(null),
    );
    try {
      const response = await routeRequest(
        mockRequest("/payment/cancel?session_id=cs_missing"),
      );
      expect((response ?? new Response()).status).toBe(400);
      const text = await (response ?? new Response()).text();
      expect(text).toContain("Payment session not found");
      expect(logs.errorContains("Session not found")).toBe(true);
    } finally {
      retrieve.restore();
    }
  });

  test("token-verified success page uses + separator in ticket URL", async () => {
    const { createTestAttendeeWithToken } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );
    const a = await createTestAttendeeWithToken("Alice", "alice@example.com");
    const b = await createTestAttendeeWithToken("Bob", "bob@example.com");

    const tokensParam = `${a.token}%2B${b.token}`;
    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${tokensParam}`),
    );
    const html = await (response ?? new Response()).text();
    expect(html).toContain("/t/");
    expect(html).toContain(`${a.token}+${b.token}`);
  });
});
