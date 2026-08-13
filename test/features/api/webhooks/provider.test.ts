// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import * as v from "valibot";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { StripeConnectionError } from "#shared/stripe/request.ts";
import { stripeApi } from "#shared/stripe.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockWebhookRequest, withExpectedError } from "#test-utils/mocks.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stripeClient } from "#test-utils/stripe/fixtures.ts";
// jscpd:ignore-end

import {
  debugLogged,
  errorLogged,
  useDebugLogSpy,
  useErrorLogSpy,
} from "#test-utils/debug-log.ts";
import {
  webhookEvent,
  withWebhookVerify,
} from "#test-utils/webhook-verify-helpers.ts";
import {
  postWebhook,
  setupMismatchWithFailingRefund,
  setupMultiMismatchWithFailingRefund,
} from "./helpers.ts";

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
    const j = v.parse(v.object({ status: v.string() }), await res.json());
    expect(j.status).toBe("pending");
  });

  test("retry session answers the fixed retryable refusal", async () => {
    await setupStripe();
    const { stripePaymentProvider } = await import(
      "#shared/stripe-provider.ts"
    );
    using _rs = stub(stripePaymentProvider, "resolveWebhookSession", () =>
      Promise.resolve("retry" as const),
    );
    using _v = await stubWebhookVerify(
      webhookEvent({
        amountTotal: 100,
        eventId: "evt_retry1",
        metadata: {},
        paymentIntent: "pi_retry1",
        sessionId: "cs_retry1",
      }),
    );
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );
    // The exact contract: fixed status, header, and value-free body — and a
    // console-only refusal, never an alert sink.
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Payment verification failed");
    expect(E().calls.length).toBe(0);
    expect(debugLogged(D, "Refused a payment callback retryably")).toBe(true);
  });

  test("Stripe fallback read failure stays retryable", async () => {
    await setupStripe();
    const client = await stripeClient();
    using _retrieve = stub(client.checkout.sessions, "retrieve", () =>
      Promise.reject(
        new StripeConnectionError(
          "network_error",
          "PRIVATE_STRIPE_READ_FAILURE",
        ),
      ),
    );
    using _verify = await stubWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_read_failure",
        metadata: {},
        paymentIntent: "pi_read_failure",
        sessionId: "cs_read_failure",
      }),
    );

    const response = await withExpectedError(() =>
      handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig" })),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE_STRIPE_READ_FAILURE");
    expect(errorLogged(E, "PRIVATE_STRIPE_READ_FAILURE")).toBe(false);
  });

  test("site-signed unreadable booking stays retryable without local state", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 500 });
    const sessionId = "cs_unreadable_private";
    const privateEmail = "private-unreadable@example.com";
    using _refund = spy(stripeApi, "refundCharge");
    using _verify = await stubWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_unreadable_private",
        metadata: signedMeta(
          {
            email: privateEmail,
            items: singleItem(listing.id, 1, 500),
            modifiers: "{}",
            name: "Private unreadable buyer",
          },
          500,
        ),
        paymentIntent: "pi_unreadable_private",
        sessionId,
      }),
    );

    const response = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig" }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Payment verification failed");
    expect(_refund.calls).toHaveLength(0);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(0);
    expect(await getProcessedPayment(sessionId)).toBeNull();
    const activity = JSON.stringify(await getAllActivityLog());
    expect(activity).toContain("Signed payment's booking could not be read");
    expect(activity).not.toContain(sessionId);
    expect(activity).not.toContain(privateEmail);
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
        expect(debugLogged(D, "Waiting for a completed payment")).toBe(true);
        expect(debugLogged(D, "pi_unp2")).toBe(false);
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
        expect(debugLogged(D, "pi_unrec3")).toBe(false);
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
        expect(debugLogged(D, "pi_uv3")).toBe(false);
        expect(debugLogged(D, "f@e.com")).toBe(false);
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
    expect(debugLogged(D, "Rejected webhook")).toBe(true);
  });

  test("webhook with missing signature returns 400 and logs", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockWebhookRequest({ private: "PRIVATE_WEBHOOK_BODY" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing signature");
    expect(errorLogged(E, "missing signature header")).toBe(true);
    expect(debugLogged(D, "Rejected webhook")).toBe(true);
    expect(debugLogged(D, "PRIVATE_WEBHOOK_BODY")).toBe(false);
  });

  test("webhook with bad signature returns 400 and logs", async () => {
    await setupStripe();
    const res = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "bad" }),
    );
    expect(res.status).toBe(400);
    expect(errorLogged(E, "verification failed")).toBe(true);
    expect(debugLogged(D, "Rejected webhook")).toBe(true);
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

  test("multi-listing webhook failure logs the first listing", async () => {
    const { first, items, refundStub, refundedStub, second } =
      await setupMultiMismatchWithFailingRefund();
    using _rf = refundStub;
    using _rd = refundedStub;

    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_multi_log",
        metadata: signedMeta(
          { email: "multi-log@example.com", items, name: "Multi log" },
          2000,
        ),
        paymentIntent: "pi_multi_log",
        sessionId: "cs_multi_log",
      }),
      (json) => expect(json.processed).toBe(false),
    );

    expect(errorLogged(E, `listing=${first.id}`)).toBe(true);
    expect(errorLogged(E, `listing=${second.id}`)).toBe(false);
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
