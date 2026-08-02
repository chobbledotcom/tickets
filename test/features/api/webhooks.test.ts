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

/** Stub the webhook verify, POST the webhook, return response and stub. */
const postWebhook = async (
  event: Parameters<typeof stubWebhookVerify>[0],
): Promise<[Response, Awaited<ReturnType<typeof stubWebhookVerify>>]> => {
  const verify = await stubWebhookVerify(event);
  return [
    await handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig" })),
    verify,
  ];
};
describeWithEnv("server (payment callback edge cases)", { db: true }, () => {
  const debugSpy = useDebugLogSpy();
  const errorSpy = useErrorLogSpy();

  test("rejects a success callback with no params", async () => {
    const res = await handleRequest(mockRequest("/payment/success"));
    const html = await res.text();
    expect(html).toContain("Invalid payment callback");
    expect(
      errorLogged(
        errorSpy,
        "no session_id or tokens | params=[none] referer=none",
      ),
    ).toBe(true);
  });

  test("rejects a success callback with only bad token params", async () => {
    const res = await handleRequest(mockRequest("/payment/success?tokens=bad"));
    const html = await res.text();
    expect(html).toContain("Invalid payment callback");
    expect(errorLogged(errorSpy, "no session_id or tokens")).toBe(false);
  });

  test("cancel rejects with Invalid payment callback when session_id is missing", async () => {
    const res = await handleRequest(mockRequest("/payment/cancel"));
    await expectHtmlResponse(res, 400, "Invalid payment callback");
    expect(errorLogged(errorSpy, "missing session_id parameter")).toBe(true);
    expect(errorLogged(errorSpy, "[cancel]")).toBe(false);
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

  test("processes the Square orderId redirect as if it were session_id", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 1000,
    });
    using _retrieve = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      email: "sq@example.com",
      items: singleItem(listing.id, 1, 1000),
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

  test("webhook returns 400 when provider is not configured", async () => {
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Payment provider not configured");
    expect(errorLogged(errorSpy, "provider not configured")).toBe(true);
    expect(debugLogged(debugSpy, "Rejected payload")).toBe(true);
  });

  test("webhook returns 400 when signature header is missing", async () => {
    await setupStripe();
    const res = await handleRequest(mockWebhookRequest({}));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing signature");
    expect(errorLogged(errorSpy, "missing signature header")).toBe(true);
    expect(debugLogged(debugSpy, "Rejected payload")).toBe(true);
  });

  test("webhook returns 400 on bad signature", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "bad" }),
    );
    expect(res.status).toBe(400);
    expect(errorLogged(errorSpy, "verification failed")).toBe(true);
    expect(debugLogged(debugSpy, "Rejected payload")).toBe(true);
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
        expect(debugLogged(debugSpy, "unrecognized payment session")).toBe(
          true,
        );
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
        expect(errorLogged(errorSpy, "Webhook session not yet paid")).toBe(
          true,
        );
        expect(debugLogged(debugSpy, "Pending payload")).toBe(true);
      },
    );
  });

  test("webhook acks a processed session as processed and received", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_processed",
        metadata: signedMeta(
          {
            email: "p@e.com",
            items: singleItem(listing.id, 1, 500),
            name: "P",
          },
          500,
        ),
        paymentIntent: "pi_processed",
        sessionId: "cs_processed",
      }),
      (json) => {
        expect(json.processed).toBe(true);
      },
    );
  });

  test("webhook returns 409 when a session is being concurrently processed", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 500,
    });
    const { reserveSession } = await import("#shared/db/processed-payments.ts");
    await reserveSession("cs_concurrent_409");
    const [res, verify] = await postWebhook(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_409",
        metadata: signedMeta(
          {
            email: "c@e.com",
            items: singleItem(listing.id, 1, 500),
            name: "C",
          },
          500,
        ),
        paymentIntent: "pi_409",
        sessionId: "cs_concurrent_409",
      }),
    );
    using _v = verify;
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("being processed");
  });

  test("webhook acks a kept-refunded booking with processed:false when the refund fails", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    using _refund = stub(stripePaymentProvider, "refundPayment", () =>
      Promise.resolve(false),
    );
    using _refunded = stub(stripePaymentProvider, "isPaymentRefunded", () =>
      Promise.resolve(false),
    );
    const [res, verify] = await postWebhook(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_kept_refund_fail",
        metadata: signedMeta(
          {
            email: "k@e.com",
            items: singleItem(listing.id, 1, 1000),
            name: "K",
          },
          1000,
        ),
        paymentIntent: "pi_kept_refund_fail",
        sessionId: "cs_kept_refund_fail",
      }),
    );
    using _v = verify;
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.processed).toBe(false);
    expect(String(json.error)).toContain("saved your details");
    expect(
      errorLogged(errorSpy, `E_PAYMENT_SESSION listing=${listing.id}`),
    ).toBe(true);
  });
});
