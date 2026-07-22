// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

const expectRejectedWebhook = async (
  request: Request,
  responseMessage: string,
  errorMessage: string,
): Promise<void> => {
  const debugLog = spy(console, "debug");
  const errorLog = spy(console, "error");
  setSuppressDebugLogs(false);
  try {
    const response = await handleRequest(request);
    await expectHtmlResponse(response, 400, responseMessage);
    const errorMessages = errorLog.calls
      .map((call) => call.args.join(" "))
      .join("\n");
    const debugMessages = debugLog.calls
      .map((call) => call.args.join(" "))
      .join("\n");
    expect(errorMessages).toContain(errorMessage);
    expect(debugMessages).toContain("Rejected payload:");
  } finally {
    debugLog.restore();
    errorLog.restore();
    setSuppressDebugLogs(null);
  }
};

describeWithEnv("server webhooks > signature validation", { db: true }, () => {
  test("returns 400 when no provider configured", async () => {
    await expectRejectedWebhook(
      mockWebhookRequest(
        { type: "checkout.session.completed" },
        { "stripe-signature": "sig_test" },
      ),
      "Payment provider not configured",
      "Webhook received but payment provider not configured",
    );
  });

  test("returns 400 when signature header is missing", async () => {
    await setupStripe();
    await expectRejectedWebhook(
      mockWebhookRequest({ type: "checkout.session.completed" }),
      "Missing signature",
      "Webhook missing signature header",
    );
  });

  test("handles trailing slash on webhook URL (body buffered correctly)", async () => {
    await setupStripe();

    // Trailing slash: /payment/webhook/ should still buffer body before
    // async context wrappers, avoiding "Cannot read body as underlying
    // resource unavailable" on the Bunny Edge runtime.
    const request = new Request("http://localhost/payment/webhook/", {
      body: JSON.stringify({ type: "checkout.session.completed" }),
      headers: {
        "content-type": "application/json",
        host: "localhost",
        "stripe-signature": "sig_test",
      },
      method: "POST",
    });

    const response = await handleRequest(request);
    // Should reach the handler and process the body (not fail on body read)
    expect(response.status).toBe(400);
    const text = await response.text();
    // Any handler-level rejection proves the body was read successfully
    expect(
      text.includes("Invalid signature") ||
        text.includes("Webhook secret not configured"),
    ).toBe(true);
  });

  test("returns 400 when signature verification fails", async () => {
    await setupStripe();

    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    const mockVerify = stub(
      stripePaymentProvider,
      "verifyWebhookSignature",
      () =>
        Promise.resolve({
          error: "Invalid signature",
          valid: false,
        }),
    );

    try {
      await expectRejectedWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_bad" }),
        "Invalid signature",
        "Webhook signature verification failed: Invalid signature",
      );
    } finally {
      mockVerify.restore();
    }
  });

  test("webhook rejects POST with wrong content-type", async () => {
    const response = await handleRequest(
      new Request("http://localhost/payment/webhook", {
        body: "test=123",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost",
          "stripe-signature": "sig_test",
        },
        method: "POST",
      }),
    );
    await expectHtmlResponse(response, 400, "Invalid Content-Type");
  });
});
