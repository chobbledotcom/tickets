// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { settings } from "#shared/db/settings.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";
// jscpd:ignore-end

import { errorLogged, useErrorLogSpy } from "#test-utils/debug-log.ts";
import {
  setupMismatchWithFailingRefund,
  setupMultiMismatchWithFailingRefund,
} from "./helpers.ts";

const expectPaymentStored = async (listingId: number): Promise<void> => {
  expect(await getAttendeesRaw(listingId)).toHaveLength(1);
};

describeWithEnv("server (payment callback edge cases)", { db: true }, () => {
  const E = useErrorLogSpy();

  test("no-param callback logs error and rejects", async () => {
    const html = await (
      await handleRequest(mockRequest("/payment/success"))
    ).text();
    expect(html).toContain("Invalid payment callback");
    expect(errorLogged(E, "params=[none] referer=none")).toBe(true);
  });

  test("bad-token callback rejects without session_id error", async () => {
    const response = await handleRequest(
      mockRequest("/payment/success?tokens=bad"),
    );
    await expectHtmlResponse(response, 400, "Invalid payment callback");
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
    await expectHtmlResponse(
      res,
      400,
      "We could not find this payment session.",
    );
    expect(errorLogged(E, "Session not found")).toBe(true);
  });

  test("cancel renders an existing Stripe session while new sales are off", async () => {
    await setupStripe();
    const l = await createTestListing({ maxAttendees: 5, unitPrice: 500 });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "cancel-off@example.com",
      items: singleItem(l.id, 1, 500),
      name: "Cancel off",
      paymentIntent: "pi_cancel_off",
      sessionId: "cs_cancel_off",
    });
    await settings.update.setPaymentProviderNone();

    const response = await handleRequest(
      mockRequest("/payment/cancel?session_id=cs_cancel_off"),
    );

    await expectHtmlResponse(response, 200, "Payment Cancelled", "Try again");
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
    expect(res.headers.get("location")).toContain("tokens=");
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
    expect(html).toContain('data-payment-result="success"');
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
    expect(res.headers.get("location")).toMatch(
      /^\/payment\/success\?tokens=.+$/,
    );
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
    await expectPaymentStored(l.id);
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
    expect(res1.status).toBe(302);
    const loc = res1.headers.get("location");
    expect(loc).toMatch(/tokens=/);
    if (loc === null) return;
    const res2 = await handleRequest(mockRequest(loc));
    const html = await res2.text();
    expect(html).toContain("/t/");
    expect(html).toContain("tok-ty.example.com");
  });

  test("no-session callback logs all param names comma-separated", async () => {
    const req = mockRequest("/payment/success?foo=bar&baz=qux");
    req.headers.set("referer", "https://evil.example.com");
    await handleRequest(req);
    expect(
      errorLogged(E, "params=[foo,baz] referer=https://evil.example.com"),
    ).toBe(true);
  });

  test("already-processed renders data-payment-result=success", async () => {
    await setupStripe();
    const l = await createTestListing({
      maxAttendees: 5,
      thankYouUrl: "https://ty2.example.com",
      unitPrice: 500,
    });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "ap2@e.com",
      items: singleItem(l.id, 1, 500),
      metadata: signedMeta(
        { email: "ap2@e.com", items: singleItem(l.id, 1, 500), name: "AP2" },
        500,
      ),
      name: "AP2",
      paymentIntent: "pi_ap_dpr",
      sessionId: "cs_ap_dpr",
    });
    await handleRequest(mockRequest("/payment/success?session_id=cs_ap_dpr"));
    await expectPaymentStored(l.id);
    const res2 = await handleRequest(
      mockRequest("/payment/success?session_id=cs_ap_dpr"),
    );
    const html = await res2.text();
    expect(html).toContain('data-payment-result="success"');
  });

  test("already-processed with no thank-you-url renders success without redirect", async () => {
    await setupStripe();
    const l = await createTestListing({
      maxAttendees: 5,
      thankYouUrl: "",
      unitPrice: 500,
    });
    using _r = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "nt2@e.com",
      items: singleItem(l.id, 1, 500),
      metadata: signedMeta(
        { email: "nt2@e.com", items: singleItem(l.id, 1, 500), name: "NT2" },
        500,
      ),
      name: "NT2",
      paymentIntent: "pi_nt_dpr",
      sessionId: "cs_nt_dpr",
    });
    await handleRequest(mockRequest("/payment/success?session_id=cs_nt_dpr"));
    await expectPaymentStored(l.id);
    const res2 = await handleRequest(
      mockRequest("/payment/success?session_id=cs_nt_dpr"),
    );
    const html = await res2.text();
    expect(html).toContain('data-payment-result="success"');
    expect(html).not.toContain("meta http-equiv");
  });

  test("empty referer header is logged as empty, not 'none'", async () => {
    const req = mockRequest("/payment/success?foo=bar");
    req.headers.set("referer", "");
    await handleRequest(req);
    expect(errorLogged(E, "referer=")).toBe(true);
    expect(errorLogged(E, "referer=none")).toBe(false);
  });

  test("redirect error path uses result.error when detail is absent", async () => {
    const { l, refundStub, refundedStub } =
      await setupMismatchWithFailingRefund(1000);
    using _rf = refundStub;
    using _rd = refundedStub;
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

  test("redirect failure logs the first listing in a multi-listing order", async () => {
    const { first, items, refundStub, refundedStub, second } =
      await setupMultiMismatchWithFailingRefund();
    using _rf = refundStub;
    using _rd = refundedStub;
    using _retrieve = stubRetrieveCheckoutSession({
      amountTotal: 500,
      email: "multi-redirect@example.com",
      items,
      metadata: signedMeta(
        { email: "multi-redirect@example.com", items, name: "Multi redirect" },
        2000,
      ),
      name: "Multi redirect",
      paymentIntent: "pi_multi_redirect",
      sessionId: "cs_multi_redirect",
    });

    await handleRequest(
      mockRequest("/payment/success?session_id=cs_multi_redirect"),
    );

    expect(errorLogged(E, `listing=${first.id}`)).toBe(true);
    expect(errorLogged(E, `listing=${second.id}`)).toBe(false);
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
    await expectPaymentStored(l.id);
    const res2 = await handleRequest(
      mockRequest("/payment/success?session_id=cs_nt_2"),
    );
    expect(res2.status).toBe(200);
    const html = await res2.text();
    expect(html).not.toContain("meta-refresh");
  });
});
