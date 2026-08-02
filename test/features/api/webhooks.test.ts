// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";
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

const postWebhook = async (event: Parameters<typeof stubWebhookVerify>[0]) => {
  const verify = await stubWebhookVerify(event);
  return [
    await handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig" })),
    verify,
  ] as const;
};

describeWithEnv("server (payment callback edge cases)", { db: true }, () => {
  const D = useDebugLogSpy();
  const E = useErrorLogSpy();

  test("no-param callback logs error and rejects", async () => {
    const html = await (
      await handleRequest(mockRequest("/payment/success"))
    ).text();
    expect(html).toContain("Invalid payment callback");
    expect(errorLogged(E, "params=[none] referer=none")).toBe(true);
  });

  test("bad-token callback rejects without session_id error", async () => {
    const html = await (
      await handleRequest(mockRequest("/payment/success?tokens=bad"))
    ).text();
    expect(html).toContain("Invalid payment callback");
    expect(errorLogged(E, "missing session_id")).toBe(false);
  });

  test("cancel with no session_id returns Invalid payment callback", async () => {
    const res = await handleRequest(mockRequest("/payment/cancel"));
    await expectHtmlResponse(res, 400, "Invalid payment callback");
    expect(errorLogged(E, "missing session_id parameter")).toBe(true);
  });

  test("cancel with no provider returns 400", async () => {
    const res = await handleRequest(
      mockRequest("/payment/cancel?session_id=cs_x"),
    );
    await expectHtmlResponse(res, 400, "Payment provider not configured");
    expect(errorLogged(E, "[cancel] No provider")).toBe(true);
  });

  test("cancel with missing session returns 400", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockRequest("/payment/cancel?session_id=cs_missing"),
    );
    await expectHtmlResponse(res, 400, "Payment session not found");
    expect(errorLogged(E, "Session not found")).toBe(true);
  });

  test("Square orderId redirect processes and includes tokens", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 5, unitPrice: 1000 });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      email: "sq@e.com",
      items: singleItem(l.id, 1, 1000),
      name: "SQ",
      paymentIntent: "pi_sq",
      sessionId: "cs_sq_order",
    });
    const res = await handleRequest(
      mockRequest("/payment/success?orderId=cs_sq_order"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("tokens=");
  });

  test("direct-render successPage when thank_you_url in metadata", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 5, unitPrice: 1000 });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      email: "ty@e.com",
      items: singleItem(l.id, 1, 1000),
      metadata: signedMeta(
        {
          email: "ty@e.com",
          items: singleItem(l.id, 1, 1000),
          name: "TY",
          thank_you_url: "https://ty.example.com",
        } as unknown as { email: string; items: string; name: string },
        1000,
      ),
      name: "TY",
      paymentIntent: "pi_ty",
      sessionId: "cs_ty",
    });
    const res = await handleRequest(
      mockRequest("/payment/success?session_id=cs_ty"),
    );
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("processed webhook returns received=true and processed=true", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 5, unitPrice: 500 });
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_p",
        metadata: signedMeta(
          { email: "p@e.com", items: singleItem(l.id, 1, 500), name: "P" },
          500,
        ),
        paymentIntent: "pi_p",
        sessionId: "cs_p",
      }),
      (j) => expect(j.processed).toBe(true),
    );
  });

  test("unrecognized session acks without processing and logs", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_u",
        metadata: {},
        paymentIntent: "pi_u",
        sessionId: "cs_u",
      }),
      (j) => {
        expect(j.received).toBe(true);
        expect(j.processed).toBeUndefined();
        expect(debugLogged(D, "Ignoring webhook")).toBe(true);
        expect(debugLogged(D, "unrecognized")).toBe(true);
      },
    );
  });

  test("unpaid session acks as pending and logs", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_un",
        metadata: { _origin: "t", email: "u@e.com", items: "[]", name: "U" },
        paymentStatus: "unpaid",
        sessionId: "cs_un",
      }),
      (j) => {
        expect(j.status).toBe("pending");
        expect(errorLogged(E, "not yet paid")).toBe(true);
        expect(debugLogged(D, "Pending payload")).toBe(true);
      },
    );
  });

  test("unverifiable session acks without processing and logs", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_uv",
        metadata: {
          _origin: "foreign",
          email: "f@e.com",
          items: "[]",
          name: "F",
        },
        paymentIntent: "pi_uv",
        sessionId: "cs_uv",
      }),
      (j) => {
        expect(j.received).toBe(true);
        expect(j.processed).toBeUndefined();
        expect(debugLogged(D, "Ignoring webhook")).toBe(true);
      },
    );
  });

  test("webhook 400 when no provider configured, logs and debugs", async () => {
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Payment provider not configured");
    expect(errorLogged(E, "provider not configured")).toBe(true);
    expect(debugLogged(D, "Rejected payload")).toBe(true);
  });

  test("webhook 400 missing signature, logs and debugs", async () => {
    await setupStripe();
    const res = await handleRequest(mockWebhookRequest({}));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing signature");
    expect(errorLogged(E, "missing signature header")).toBe(true);
    expect(debugLogged(D, "Rejected payload")).toBe(true);
  });

  test("webhook 400 bad signature, logs error and debug", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "bad" }),
    );
    expect(res.status).toBe(400);
    expect(errorLogged(E, "verification failed")).toBe(true);
    expect(debugLogged(D, "Rejected payload")).toBe(true);
  });

  test("concurrent reservation returns 409", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 50, unitPrice: 500 });
    const { reserveSession } = await import("#shared/db/processed-payments.ts");
    await reserveSession("cs_409");
    const [res, verify] = await postWebhook(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_409",
        metadata: signedMeta(
          { email: "c@e.com", items: singleItem(l.id, 1, 500), name: "C" },
          500,
        ),
        paymentIntent: "pi_409",
        sessionId: "cs_409",
      }),
    );
    using _v = verify;
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("being processed");
  });

  test("kept-refunded booking with failed refund acks as processed:false", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 50, unitPrice: 1000 });
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    using _rf = stub(stripePaymentProvider, "refundPayment", () =>
      Promise.resolve(false),
    );
    using _rd = stub(stripePaymentProvider, "isPaymentRefunded", () =>
      Promise.resolve(false),
    );
    const [res, verify] = await postWebhook(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_kr",
        metadata: signedMeta(
          { email: "k@e.com", items: singleItem(l.id, 1, 1000), name: "K" },
          1000,
        ),
        paymentIntent: "pi_kr",
        sessionId: "cs_kr",
      }),
    );
    using _v = verify;
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.processed).toBe(false);
    expect(String(j.error)).toContain("saved your details");
    expect(errorLogged(E, `listing=${l.id}`)).toBe(true);
  });
});
