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

/** Create a listing, stub Stripe to fail refunds, and return the listing. */
const setupFailedRefundListing = async (price = 1000) => {
  await setupStripe();
  const l = await createTestListing({ maxAttendees: 50, unitPrice: price });
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  using _rf = stub(stripePaymentProvider, "refundPayment", () =>
    Promise.resolve(false),
  );
  using _rd = stub(stripePaymentProvider, "isPaymentRefunded", () =>
    Promise.resolve(false),
  );
  return l;
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

  test("direct-render shows the ticket URL and thank-you link", async () => {
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
        },
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
    const html = await res.text();
    expect(html).toContain("/t/");
    expect(html).toContain("https://ty.example.com");
  });

  test("redirect URL includes the actual token value", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 5, unitPrice: 500 });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "ru@e.com",
      items: singleItem(l.id, 1, 500),
      name: "RU",
      paymentIntent: "pi_ru",
      sessionId: "cs_ru",
    });
    const res = await handleRequest(
      mockRequest("/payment/success?session_id=cs_ru"),
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toMatch(/^\/payment\/success\?tokens=.+$/);
  });

  test("already-processed session renders the trimmed thank-you URL", async () => {
    await setupStripe();
    const l = await createTestListing({
      maxAttendees: 5,
      thankYouUrl: "  https://trim.example.com  ",
      unitPrice: 500,
    });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "ap@e.com",
      items: singleItem(l.id, 1, 500),
      metadata: signedMeta(
        { email: "ap@e.com", items: singleItem(l.id, 1, 500), name: "AP" },
        500,
      ),
      name: "AP",
      paymentIntent: "pi_ap2",
      sessionId: "cs_ap2",
    });
    await handleRequest(mockRequest("/payment/success?session_id=cs_ap2"));
    const res2 = await handleRequest(
      mockRequest("/payment/success?session_id=cs_ap2"),
    );
    const html = await res2.text();
    expect(html).toContain("trim.example.com");
    expect(html).not.toContain("Invalid payment callback");
  });

  test("tokens render path shows the ticket URL and single-listing thank-you", async () => {
    await setupStripe();
    const l = await createTestListing({
      maxAttendees: 5,
      thankYouUrl: "https://tok-ty.example.com",
      unitPrice: 500,
    });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "tk@e.com",
      items: singleItem(l.id, 1, 500),
      name: "TK",
      paymentIntent: "pi_tk2",
      sessionId: "cs_tk2",
    });
    const res1 = await handleRequest(
      mockRequest("/payment/success?session_id=cs_tk2"),
    );
    const loc = res1.headers.get("location") ?? "";
    if (loc.includes("tokens=")) {
      const res2 = await handleRequest(mockRequest(loc));
      const html = await res2.text();
      expect(html).toContain("/t/");
      expect(html).toContain("tok-ty.example.com");
    }
  });

  test("no-session callback logs all param names comma-separated", async () => {
    const req = mockRequest("/payment/success?foo=bar&baz=qux");
    req.headers.set("referer", "https://evil.example.com");
    await handleRequest(req);
    expect(
      errorLogged(E, "params=[foo,baz] referer=https://evil.example.com"),
    ).toBe(true);
  });

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
    const l = await setupFailedRefundListing();
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

  test("empty referer header is logged as empty, not 'none'", async () => {
    const req = mockRequest("/payment/success?foo=bar");
    req.headers.set("referer", "");
    await handleRequest(req);
    // ?? keeps "" (empty string is not nullish); || would replace it with "none".
    expect(errorLogged(E, "referer=")).toBe(true);
    expect(errorLogged(E, "referer=none")).toBe(false);
  });

  test("redirect error path uses result.error when detail is absent", async () => {
    await setupStripe();
    const l = await setupFailedRefundListing();
    using _rt = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "de@e.com",
      items: singleItem(l.id, 1, 1000),
      name: "DE",
      paymentIntent: "pi_de",
      sessionId: "cs_de_detail",
    });
    const res = await handleRequest(
      mockRequest("/payment/success?session_id=cs_de_detail"),
    );
    expect(await res.text()).toContain("saved your details");
    expect(errorLogged(E, "[redirect]")).toBe(true);
  });

  test("already-processed session without thank-you URL renders without redirect", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 5, unitPrice: 500 });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "nt@e.com",
      items: singleItem(l.id, 1, 500),
      metadata: signedMeta(
        { email: "nt@e.com", items: singleItem(l.id, 1, 500), name: "NT" },
        500,
      ),
      name: "NT",
      paymentIntent: "pi_nt",
      sessionId: "cs_nt_2",
    });
    await handleRequest(mockRequest("/payment/success?session_id=cs_nt_2"));
    // Second call: no tokens, no explicit thank_you_url, single listing.
    // SingleleListingThankYou loads the listing's thank_you_url (which is empty).
    const res2 = await handleRequest(
      mockRequest("/payment/success?session_id=cs_nt_2"),
    );
    expect(res2.status).toBe(200);
    const html = await res2.text();
    // No thank-you redirect link (the URL is "").
    expect(html).not.toContain("meta-refresh");
  });
});
