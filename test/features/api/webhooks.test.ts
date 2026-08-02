// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
// jscpd:ignore-end

import {
  debugLogged,
  errorLogged,
  useDebugLogSpy,
  useErrorLogSpy,
} from "#test-utils/log-spy.ts";
import {
  webhookEvent,
  withWebhookVerify,
} from "#test-utils/webhook-verify-helpers.ts";

describeWithEnv("server (payment callback edge cases)", { db: true }, () => {
  const debugSpy = useDebugLogSpy();
  const errorSpy = useErrorLogSpy();

  test("rejects a success callback with no params", async () => {
    const res = await handleRequest(mockRequest("/payment/success"));
    const html = await res.text();
    expect(html).toContain("Invalid payment callback");
    expect(errorLogged(errorSpy, "no session_id or tokens")).toBe(true);
  });

  test("rejects a success callback with only bad token params", async () => {
    const res = await handleRequest(mockRequest("/payment/success?tokens=bad"));
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("cancel returns error when no provider is configured", async () => {
    const res = await handleRequest(
      mockRequest("/payment/cancel?session_id=cs_x"),
    );
    await expectHtmlResponse(res, 400, "Payment provider not configured");
    expect(errorLogged(errorSpy, "[cancel] No provider configured")).toBe(true);
  });

  test("cancel returns error when session is not found", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockRequest("/payment/cancel?session_id=cs_missing"),
    );
    await expectHtmlResponse(res, 400, "Payment session not found");
    expect(errorLogged(errorSpy, "Session not found")).toBe(true);
  });

  test("webhook returns 400 when provider is not configured", async () => {
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Payment provider not configured");
    expect(errorLogged(errorSpy, "provider not configured")).toBe(true);
  });

  test("webhook returns 400 when signature header is missing", async () => {
    await setupStripe();
    const res = await handleRequest(mockWebhookRequest({}));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing signature");
    expect(errorLogged(errorSpy, "missing signature header")).toBe(true);
  });

  test("webhook returns 400 on bad signature", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "bad" }),
    );
    expect(res.status).toBe(400);
    expect(errorLogged(errorSpy, "verification failed")).toBe(true);
  });

  test("webhook acks an unrecognized session without processing", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_unrec",
        metadata: {},
        paymentIntent: "pi_unrec",
        sessionId: "cs_unrec",
      }),
      (json) => {
        expect(json.received).toBe(true);
        expect(json.processed).toBeUndefined();
        expect(debugLogged(debugSpy, "Ignoring webhook")).toBe(true);
      },
    );
  });

  test("webhook acks an unpaid session as pending", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_unpaid",
        metadata: { _origin: "t", email: "u@e.com", items: "[]", name: "U" },
        paymentStatus: "unpaid",
        sessionId: "cs_unpaid",
      }),
      (json) => {
        expect(json.status).toBe("pending");
      },
    );
  });
});
