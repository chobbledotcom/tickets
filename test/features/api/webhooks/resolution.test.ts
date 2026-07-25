import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  checkoutEvent,
  createSoldOutListing,
  expectLoggedErrorResponse,
  restoreAll,
  routedResponse,
  sendWebhook,
  stripeWebhookResponse,
  stubFailedRefund,
  stubPaidSession,
  stubRetrieveSession,
} from "./helpers.ts";

describeWithEnv("payment webhook resolution", { db: true }, () => {
  const errors = setupErrorSpy();
  const debug = useDebugLogSpy();

  /** Assert a webhook response is a 200 ack with { received: true } and that
   * the debug log contains the given substring. */
  const expectAcknowledgedWithDebug = async (
    response: Response,
    debugSubstring: string,
  ): Promise<void> => {
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ received: true });
    expect(
      debugMessages(debug()).some((m) => String(m).includes(debugSubstring)),
    ).toBe(true);
  };

  /** Assert a 400 webhook response with the given error text, logged error
   * substring, and a "Rejected payload" debug log. */
  const expectRejected400 = async (
    response: Response,
    textSubstring: string,
    errorSubstring: string,
  ): Promise<void> => {
    await expectLoggedErrorResponse(
      response,
      400,
      textSubstring,
      errorSubstring,
      (message) => errors.contains(message),
    );
    expect(
      debugMessages(debug()).some((m) =>
        String(m).includes("Rejected payload"),
      ),
    ).toBe(true);
  };

  const expectPaidSessionParam = async (
    param: "session_id" | "orderId",
    sessionId: string,
    paymentIntent: string,
    listing: { id: number },
  ): Promise<void> => {
    const retrieve = await stubRetrieveSession(
      sessionId,
      paymentIntent,
      listing,
      1000,
      { thank_you_url: "https://example.com/thanks" },
    );
    try {
      const response = await routedResponse(
        mockRequest(`/payment/success?${param}=${sessionId}`),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data-payment-result="success"');
    } finally {
      retrieve.restore();
    }
  };

  test("requests provider retry when session resolution is temporary", async () => {
    await setupStripe();
    const resolve = stub(stripePaymentProvider, "resolveWebhookSession", () =>
      Promise.resolve("retry" as const),
    );
    const response = await stripeWebhookResponse(resolve, "evt_retry");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "retry" });
  });

  test("acknowledges skip sessions as pending", async () => {
    await setupStripe();
    const resolve = stub(stripePaymentProvider, "resolveWebhookSession", () =>
      Promise.resolve("skip" as const),
    );
    const response = await stripeWebhookResponse(resolve, "evt_skip");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ received: true, status: "pending" });
  });

  test("acknowledges unrecognized sessions and logs debug", async () => {
    await setupStripe();
    const resolve = stub(stripePaymentProvider, "resolveWebhookSession", () =>
      Promise.resolve(null),
    );
    const response = await stripeWebhookResponse(resolve, "evt_unknown");
    await expectAcknowledgedWithDebug(
      response,
      "Ignoring webhook for unrecognized",
    );
  });

  test("acknowledges non-checkout event types without processing", async () => {
    await setupStripe();
    const verify = await stubWebhookVerify(
      checkoutEvent("evt_other", "payment_intent.created"),
    );
    try {
      const response = await sendWebhook();
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ received: true });
    } finally {
      verify.restore();
    }
  });

  test("returns 400 when no provider configured and logs debug rejection", async () => {
    await expectRejected400(
      await sendWebhook(),
      "Payment provider not configured",
      "Webhook received but payment provider not configured",
    );
  });

  test("returns 400 when signature header missing and logs error", async () => {
    await setupStripe();
    const verify = await stubWebhookVerify(checkoutEvent("evt_nosig"));
    try {
      await expectRejected400(
        await routedResponse(mockWebhookRequest({})),
        "Missing signature",
        "Webhook missing signature header",
      );
    } finally {
      verify.restore();
    }
  });

  test("returns 400 when signature verification fails and logs error", async () => {
    await setupStripe();
    const verify = stub(stripePaymentProvider, "verifyWebhookSignature", () =>
      Promise.resolve({ error: "signature mismatch", valid: false }),
    );
    try {
      await expectRejected400(
        await routedResponse(
          mockWebhookRequest({}, { "stripe-signature": "sig_bad" }),
        ),
        "signature mismatch",
        "signature verification failed",
      );
    } finally {
      verify.restore();
    }
  });

  test("logs listingId on webhook processing failure", async () => {
    await setupStripe();
    const listing = await createSoldOutListing();

    const resolve = stubPaidSession({
      id: "cs_webhook_fail",
      listing,
      paymentIntent: "pi_webhook_fail",
    });
    const response = await stripeWebhookResponse(resolve, "evt_fail");
    // Sold-out: processing fails, result is acknowledged but not processed,
    // and the error log must carry the listingId
    expect(response.status).toBe(200);
    expect(errors.contains(`listing=${listing.id}`)).toBe(true);
  });

  test("acknowledges a stored booking after its refund attempt fails", async () => {
    await setupStripe();
    const listing = await createSoldOutListing();
    const refundStubs = stubFailedRefund();
    const resolve = stubPaidSession({
      id: "cs_unrefunded",
      listing,
      paymentIntent: "pi_unrefunded",
    });
    try {
      const response = await stripeWebhookResponse(resolve, "evt_unrefunded");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        error: expect.stringContaining("refund is being arranged"),
        processed: false,
        received: true,
      });
    } finally {
      restoreAll(...refundStubs);
    }
  });

  test("requests retry when an inactive listing cannot be refunded", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    await deactivateTestListing(listing.id);
    const refundStubs = stubFailedRefund();
    const resolve = stubPaidSession({
      id: "cs_inactive_unrefunded",
      listing,
      paymentIntent: "pi_inactive_unrefunded",
    });
    try {
      const response = await stripeWebhookResponse(
        resolve,
        "evt_inactive_unrefunded",
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe(
        "This listing is no longer accepting registrations.",
      );
    } finally {
      restoreAll(...refundStubs);
    }
  });

  test("processes a paid session and returns processed: true", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    const resolve = stubPaidSession({
      id: "cs_webhook_ok",
      listing,
      paymentIntent: "pi_webhook_ok",
      paymentStatus: "paid",
    });
    const response = await stripeWebhookResponse(resolve, "evt_ok");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ processed: true, received: true });
  });

  test("returns 409 when the session is already being processed", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    // Reserve the session so the webhook hits the "being processed" 409 path
    await reserveSession("cs_conflict");

    const resolve = stubPaidSession({
      id: "cs_conflict",
      listing,
      paymentIntent: "pi_conflict",
    });
    const response = await stripeWebhookResponse(resolve, "evt_conflict");
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("being processed");
  });

  test("acknowledges unpaid checkout as pending and logs error", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const resolve = stubPaidSession({
      id: "cs_unpaid",
      listing,
      paymentIntent: "pi_test",
      paymentStatus: "unpaid",
    });
    const response = await stripeWebhookResponse(resolve, "evt_unpaid");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ received: true, status: "pending" });
    expect(errors.contains("Webhook session not yet paid")).toBe(true);
    expect(
      debugMessages(debug()).some((m) => String(m).includes("Pending payload")),
    ).toBe(true);
  });

  test("acknowledges unverifiable session and logs debug", async () => {
    await setupStripe();
    const resolve = stub(stripePaymentProvider, "resolveWebhookSession", () =>
      Promise.resolve({
        amountTotal: 1000,
        id: "cs_unverifiable",
        metadata: webhookMeta({ name: "John" }),
        paymentReference: "pi_test",
        paymentStatus: "paid",
      }),
    );
    const response = await stripeWebhookResponse(resolve, "evt_unverifiable");
    await expectAcknowledgedWithDebug(
      response,
      "Ignoring webhook for unverifiable session",
    );
  });

  test("marks success page as paid for a processed redirect", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/thanks",
      unitPrice: 1000,
    });

    await expectPaidSessionParam("session_id", "cs_paid", "pi_test", listing);
  });

  test("uses orderId query param when session_id is absent", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/thanks",
      unitPrice: 1000,
    });

    await expectPaidSessionParam(
      "orderId",
      "cs_order_param",
      "pi_order_param",
      listing,
    );
  });

  test("already-processed redirect renders success page with listing thank-you URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 1000,
    });

    const retrieve = await stubRetrieveSession(
      "cs_processed",
      "pi_processed",
      listing,
      1000,
      { thank_you_url: "https://example.com/explicit-thanks" },
    );

    try {
      // First hit: processes and direct-renders (explicit thank-you + tokens)
      const first = await routedResponse(
        mockRequest("/payment/success?session_id=cs_processed"),
      );
      expect(first.status).toBe(200);
      const firstHtml = await first.text();
      expect(firstHtml).toContain("https://example.com/explicit-thanks");
      expect(firstHtml).toContain('data-payment-result="success"');

      // Second hit: already-processed, no tokens; the explicit thank-you URL
      // must be preserved (not overwritten by singleListingThankYou)
      const second = await routedResponse(
        mockRequest("/payment/success?session_id=cs_processed"),
      );
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(secondHtml).toContain("https://example.com/explicit-thanks");
      expect(secondHtml).toContain('data-payment-result="success"');
    } finally {
      retrieve.restore();
    }
  });

  test("logged listingId on redirect failure matches first item", async () => {
    await setupStripe();
    const listing = await createSoldOutListing();

    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_fail_log",
        metadata: signedMeta(
          {
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
          },
          1000,
        ),
        payment_intent: "pi_fail_log",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      const response = await routedResponse(
        mockRequest("/payment/success?session_id=cs_fail_log"),
      );
      // Sold-out listing: processPaymentSession fails, logs [redirect] with listingId
      expect(response.status).toBe(200);
      expect(errors.contains(`listing=${listing.id}`)).toBe(true);
    } finally {
      retrieve.restore();
    }
  });
});
