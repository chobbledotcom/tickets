// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
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
import { postWebhook, setupMismatchWithFailingRefund } from "./helpers.ts";

describeWithEnv("server (payment webhook edge cases)", { db: true }, () => {
  const D = useDebugLogSpy();
  const E = useErrorLogSpy();

  test("skip session returns pending status", async () => {
    await setupStripe();
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    using _rs = stub(stripePaymentProvider, "resolveWebhookSession", () =>
      Promise.resolve("skip" as const),
    );
    using _v = await stubWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_skip2",
        metadata: {},
        paymentIntent: "pi_skip2",
        sessionId: "cs_skip2",
      }),
    );
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.status).toBe("pending");
  });

  test("unpaid session acks as pending and logs", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_unp2",
        metadata: { _origin: "t", email: "u@e.com", items: "[]", name: "U" },
        paymentStatus: "unpaid",
        sessionId: "cs_unp2",
      }),
      (j) => {
        expect(j.status).toBe("pending");
        expect(errorLogged(E, "not yet paid")).toBe(true);
        expect(debugLogged(D, "Pending payload")).toBe(true);
      },
    );
  });

  test("unrecognized session acks without processing and logs 'unrecognized'", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_unrec3",
        metadata: {},
        paymentIntent: "pi_unrec3",
        sessionId: "cs_unrec3",
      }),
      (j) => {
        expect(j.received).toBe(true);
        expect(j.processed).toBeUndefined();
        expect(debugLogged(D, "unrecognized payment session")).toBe(true);
      },
    );
  });

  test("unverifiable session acks without processing and logs 'unverifiable'", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_uv3",
        metadata: {
          _origin: "foreign",
          email: "f@e.com",
          items: "[]",
          name: "F",
        },
        paymentIntent: "pi_uv3",
        sessionId: "cs_uv3",
      }),
      (j) => {
        expect(j.received).toBe(true);
        expect(j.processed).toBeUndefined();
        expect(debugLogged(D, "unverifiable session")).toBe(true);
      },
    );
  });

  test("webhook with no provider returns 400 and logs rejection", async () => {
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Payment provider not configured");
    expect(errorLogged(E, "provider not configured")).toBe(true);
    expect(debugLogged(D, "Rejected payload")).toBe(true);
  });

  test("webhook with missing signature returns 400 and logs", async () => {
    await setupStripe();
    const res = await handleRequest(mockWebhookRequest({}));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing signature");
    expect(errorLogged(E, "missing signature header")).toBe(true);
    expect(debugLogged(D, "Rejected payload")).toBe(true);
  });

  test("webhook with bad signature returns 400 and logs", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "bad" }),
    );
    expect(res.status).toBe(400);
    expect(errorLogged(E, "verification failed")).toBe(true);
    expect(debugLogged(D, "Rejected payload")).toBe(true);
  });

  test("processed webhook returns received=true and processed=true", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 5, unitPrice: 500 });
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_p2",
        metadata: signedMeta(
          { email: "p@e.com", items: singleItem(l.id, 1, 500), name: "P" },
          500,
        ),
        paymentIntent: "pi_p2",
        sessionId: "cs_p2",
      }),
      (j) => expect(j.processed).toBe(true),
    );
  });

  test("concurrent reservation returns 409 with being-processed message", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 50, unitPrice: 500 });
    const { reserveSession } = await import("#shared/db/processed-payments.ts");
    await reserveSession("cs_409b");
    const [res, verify] = await postWebhook(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_409b",
        metadata: signedMeta(
          { email: "c@e.com", items: singleItem(l.id, 1, 500), name: "C" },
          500,
        ),
        paymentIntent: "pi_409b",
        sessionId: "cs_409b",
      }),
    );
    using _v = verify;
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("being processed");
  });

  test("kept-refunded webhook acks with the correct listing in the error log", async () => {
    const { l, refundStub, refundedStub } =
      await setupMismatchWithFailingRefund();
    using _rf = refundStub;
    using _rd = refundedStub;
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_kr2",
        metadata: signedMeta(
          { email: "k@e.com", items: singleItem(l.id, 1, 1000), name: "K" },
          1000,
        ),
        paymentIntent: "pi_kr2",
        sessionId: "cs_kr2",
      }),
      (j) => {
        expect(j.processed).toBe(false);
        expect(String(j.error)).toContain("saved your details");
      },
    );
    expect(errorLogged(E, `listing=${l.id}`)).toBe(true);
  });

  test("validation-failure refund returns 503 status", async () => {
    const { l, refundStub, refundedStub } =
      await setupMismatchWithFailingRefund(1000);
    using _rf = refundStub;
    using _rd = refundedStub;
    await deactivateTestListing(l.id);
    const [res, verify] = await postWebhook(
      webhookEvent({
        amountTotal: 1000,
        eventId: "evt_503v",
        metadata: signedMeta(
          { email: "v@e.com", items: singleItem(l.id, 1, 1000), name: "V" },
          1000,
        ),
        paymentIntent: "pi_503v",
        sessionId: "cs_503v",
      }),
    );
    using _v = verify;
    expect(res.status).toBe(503);
  });
});
