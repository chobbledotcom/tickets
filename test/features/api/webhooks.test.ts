import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Spy } from "@std/testing/mock";
import { stub } from "@std/testing/mock";
import { handlePaymentWebhook, routePayment } from "#routes/api/webhooks.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";

/** Call the payment router with path/method extracted from the request. */
const routeRequest = (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  return routePayment(request, url.pathname, request.method);
};

/** Webhook event id + type paired for stubWebhookVerify. */
const checkoutEvent = (id: string, type = "checkout.session.completed") => ({
  data: { object: {} },
  id,
  type,
});

/** Send a signed webhook request and return the response. */
const sendWebhook = () =>
  handlePaymentWebhook(
    mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
  );

/** Restore all stubs in reverse order (like a finally block). */
const restoreAll = (...stubs: Spy[]): void => {
  for (const s of stubs.reverse()) s.restore();
};

/** Create a listing and fill it to capacity so a subsequent booking fails. */
const createSoldOutListing = async (
  unitPrice = 1000,
): ReturnType<typeof createTestListing> => {
  const listing = await createTestListing({ maxAttendees: 1, unitPrice });
  const { createTestAttendeeDirect } = await import(
    "#test-utils/db-helpers/attendees.ts"
  );
  await createTestAttendeeDirect(listing.id, "First", "first@example.com", 1);
  return listing;
};

/** Stub stripeApi.retrieveCheckoutSession to return a session with the given
 * id, payment intent, metadata fields, and amount. Returns the stub to
 * restore in a finally block. */
const stubRetrieveSession = async (
  sessionId: string,
  paymentIntent: string,
  listing: { id: number },
  unitPrice: number,
  extraMeta: Record<string, string> = {},
) => {
  const { stripeApi } = await import("#shared/stripe.ts");
  return stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: unitPrice,
      id: sessionId,
      metadata: signedMeta(
        {
          email: "john@example.com",
          items: singleItem(listing.id, 1, unitPrice),
          name: "John",
          ...extraMeta,
        },
        unitPrice,
      ),
      payment_intent: paymentIntent,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );
};

/** Set up a Stripe webhook test: resolve stub + verify stub, return the
 * webhook response, and restore both stubs afterwards. */
const stripeWebhookResponse = async (
  resolve: Spy,
  eventId: string,
  eventType = "checkout.session.completed",
): Promise<Response> => {
  const verify = await stubWebhookVerify(checkoutEvent(eventId, eventType));
  try {
    return await sendWebhook();
  } finally {
    restoreAll(verify, resolve);
  }
};

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
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(textSubstring);
    expect(errors.contains(errorSubstring)).toBe(true);
    expect(
      debugMessages(debug()).some((m) =>
        String(m).includes("Rejected payload"),
      ),
    ).toBe(true);
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
      await handlePaymentWebhook(
        mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
      ),
      "Payment provider not configured",
      "Webhook received but payment provider not configured",
    );
  });

  test("returns 400 when signature header missing and logs error", async () => {
    await setupStripe();
    const verify = await stubWebhookVerify(checkoutEvent("evt_nosig"));
    try {
      await expectRejected400(
        await handlePaymentWebhook(mockWebhookRequest({})),
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
        await handlePaymentWebhook(
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

    const resolve = stub(stripePaymentProvider, "resolveWebhookSession", () =>
      Promise.resolve({
        amountTotal: 1000,
        id: "cs_webhook_fail",
        metadata: signedMeta(
          {
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
          },
          1000,
        ),
        paymentReference: "pi_webhook_fail",
        paymentStatus: "paid",
      }),
    );
    const response = await stripeWebhookResponse(resolve, "evt_fail");
    // Sold-out: processing fails, result is acknowledged but not processed,
    // and the error log must carry the listingId
    expect(response.status).toBe(200);
    expect(errors.contains(`listing=${listing.id}`)).toBe(true);
  });

  test("acknowledges unpaid checkout as pending and logs error", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const resolve = stub(stripePaymentProvider, "resolveWebhookSession", () =>
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

    const retrieve = await stubRetrieveSession(
      "cs_paid",
      "pi_test",
      listing,
      1000,
      { thank_you_url: "https://example.com/thanks" },
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
      const first = await routeRequest(
        mockRequest("/payment/success?session_id=cs_processed"),
      );
      const firstHtml = await (first ?? new Response()).text();
      expect(firstHtml).toContain("https://example.com/explicit-thanks");
      expect(firstHtml).toContain('data-payment-result="success"');

      // Second hit: already-processed, no tokens; the explicit thank-you URL
      // must be preserved (not overwritten by singleListingThankYou)
      const second = await routeRequest(
        mockRequest("/payment/success?session_id=cs_processed"),
      );
      const secondHtml = await (second ?? new Response()).text();
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
      const response = await routeRequest(
        mockRequest("/payment/success?session_id=cs_fail_log"),
      );
      // Sold-out listing: processPaymentSession fails, logs [redirect] with listingId
      expect((response ?? new Response()).status).toBe(200);
      expect(errors.contains(`listing=${listing.id}`)).toBe(true);
    } finally {
      retrieve.restore();
    }
  });
});

describeWithEnv("payment callback params", { db: true }, () => {
  const errors = setupErrorSpy();

  /** Assert a callback response is a 400 with the "Invalid payment callback" body. */
  const expectInvalidCallback = async (
    response: Response | null,
  ): Promise<void> => {
    expect((response ?? new Response()).status).toBe(400);
    expect(await (response ?? new Response()).text()).toContain(
      "Invalid payment callback",
    );
  };

  /** Assert a callback response is a 400 with the given text substring and
   * logged error substring. */
  const expect400With = async (
    response: Response | null,
    textSubstring: string,
    errorSubstring: string,
  ): Promise<void> => {
    expect((response ?? new Response()).status).toBe(400);
    expect(await (response ?? new Response()).text()).toContain(textSubstring);
    expect(errors.contains(errorSubstring)).toBe(true);
  };

  test("returns error for missing session_id on cancel and logs error", async () => {
    await expectInvalidCallback(
      await routeRequest(mockRequest("/payment/cancel")),
    );
    expect(
      errors.contains("Payment callback missing session_id parameter"),
    ).toBe(true);
  });

  test("returns error for missing session_id on success", async () => {
    await expectInvalidCallback(
      await routeRequest(mockRequest("/payment/success")),
    );
  });

  test("returns error for success with no params and logs none fallback", async () => {
    // No query params at all: paramKeys falls back to "none", referer to "none"
    const response = await routeRequest(
      mockRequest("/payment/success", { headers: {} }),
    );
    expect((response ?? new Response()).status).toBe(400);
    expect(errors.contains("params=[none]")).toBe(true);
    expect(errors.contains("referer=none")).toBe(true);
  });

  test("returns error for success with no session_id or tokens and logs error", async () => {
    const response = await routeRequest(
      mockRequest("/payment/success?foo=bar&baz=qux"),
    );
    expect((response ?? new Response()).status).toBe(400);
    expect(errors.contains("no session_id or tokens")).toBe(true);
    expect(errors.contains("params=[foo,baz]")).toBe(true);
    expect(errors.contains("referer=none")).toBe(true);
  });

  test("cancel returns error when no provider configured and logs cancel error", async () => {
    await expect400With(
      await routeRequest(
        mockRequest("/payment/cancel?session_id=cs_noprovider"),
      ),
      "Payment provider not configured",
      "[cancel] No provider configured",
    );
  });

  test("cancel returns error when session not found and logs cancel error", async () => {
    await setupStripe();
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve(null),
    );
    try {
      await expect400With(
        await routeRequest(
          mockRequest("/payment/cancel?session_id=cs_missing"),
        ),
        "Payment session not found",
        "[cancel] Session not found",
      );
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

  test("token-verified single-listing success page shows thank-you URL", async () => {
    const { createTestAttendeeWithToken } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );
    const { token } = await createTestAttendeeWithToken(
      "Alice",
      "alice@example.com",
      { thankYouUrl: "https://example.com/alice-thanks" },
    );

    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${token}`),
    );
    const html = await (response ?? new Response()).text();
    expect(html).toContain("/t/");
    expect(html).toContain(token);
    // The listing's thank-you URL is resolved and rendered
    expect(html).toContain("https://example.com/alice-thanks");
  });

  test("already-processed direct render after token-clearing redirect shows paid success", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 1000,
    });

    const retrieve = await stubRetrieveSession(
      "cs_clearing",
      "pi_clearing",
      listing,
      1000,
    );

    try {
      // First hit: no explicit thank-you URL, so the redirect path runs and
      // clears the stored ticket tokens (line 155).
      const first = await routeRequest(
        mockRequest("/payment/success?session_id=cs_clearing"),
      );
      // First hit is a redirect (302), not a direct render
      const firstResponse = first ?? new Response();
      expect(firstResponse.status).toBe(302);
      const redirect = firstResponse.headers.get("location") ?? "";
      expect(redirect).toContain("/payment/success?tokens=");

      // Second hit: tokens are now empty → falls to the direct-render
      // already-processed path (line 172), which resolves the listing's
      // thank-you URL via singleListingThankYou.
      const second = await routeRequest(
        mockRequest("/payment/success?session_id=cs_clearing"),
      );
      const secondHtml = await (second ?? new Response()).text();
      // paid: true must be rendered → data-payment-result="success"
      expect(secondHtml).toContain('data-payment-result="success"');
      // The listing's own thank-you URL is used
      expect(secondHtml).toContain("https://example.com/listing-thanks");
    } finally {
      retrieve.restore();
    }
  });

  test("already-processed with explicit thank-you preserves it over listing's URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 1000,
    });

    const { clearSessionTokens } = await import(
      "#shared/db/processed-payments.ts"
    );
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_explicit",
        metadata: signedMeta(
          {
            email: "bob@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Bob",
            thank_you_url: "https://example.com/explicit-thanks",
          },
          1000,
        ),
        payment_intent: "pi_explicit",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      // First hit: processes and direct-renders with explicit thank-you + tokens
      const first = await routeRequest(
        mockRequest("/payment/success?session_id=cs_explicit"),
      );
      const firstHtml = await (first ?? new Response()).text();
      expect(firstHtml).toContain("https://example.com/explicit-thanks");

      // Simulate a webhook racing in and consuming the tokens
      await clearSessionTokens("cs_explicit");

      // Second hit: tokens now empty, but explicit thank-you is still in
      // metadata. The explicit URL must win — not be replaced by the
      // listing's own thank-you URL.
      const second = await routeRequest(
        mockRequest("/payment/success?session_id=cs_explicit"),
      );
      const secondHtml = await (second ?? new Response()).text();
      expect(secondHtml).toContain("https://example.com/explicit-thanks");
      expect(secondHtml).not.toContain("https://example.com/listing-thanks");
    } finally {
      retrieve.restore();
    }
  });

  test("token-verified hidden package member success page suppresses thank-you URL", async () => {
    const { createHiddenPackageGroup } = await import(
      "#test-utils/db-helpers/groups.ts"
    );
    const { createTestAttendeeDirect } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );

    const group = await createHiddenPackageGroup("Hidden Pkg");
    const listing = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      thankYouUrl: "https://example.com/concealed-thanks",
      unitPrice: 1000,
    });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Hidden",
      "hidden@example.com",
      1,
    );
    const token = attendee.ticket_token;

    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${token}`),
    );
    const html = await (response ?? new Response()).text();
    // The hidden package member's thank-you URL must not leak
    expect(html).not.toContain("https://example.com/concealed-thanks");
    // No meta-refresh redirect should be rendered (thankYouUrl is empty)
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test("already-processed for a since-deleted listing renders no thank-you URL", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/deleted-listing-thanks",
      unitPrice: 1000,
    });

    const { deleteListing } = await import("#shared/db/listings/delete.ts");
    const { stripeApi } = await import("#shared/stripe.ts");
    const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
      Promise.resolve({
        amount_total: 1000,
        id: "cs_deleted_listing",
        metadata: signedMeta(
          {
            email: "carol@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Carol",
          },
          1000,
        ),
        payment_intent: "pi_deleted_listing",
        payment_status: "paid",
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >),
    );

    try {
      // First hit: processes and redirects (clearing tokens)
      const first = await routeRequest(
        mockRequest("/payment/success?session_id=cs_deleted_listing"),
      );
      expect((first ?? new Response()).status).toBe(302);

      // Delete the listing between requests
      await deleteListing(listing.id);

      // Second hit: listing gone, tokens cleared; singleListingThankYou
      // returns "" for a deleted listing (no meta-refresh, no redirect link)
      const second = await routeRequest(
        mockRequest("/payment/success?session_id=cs_deleted_listing"),
      );
      const secondHtml = await (second ?? new Response()).text();
      expect(secondHtml).not.toContain(
        "https://example.com/deleted-listing-thanks",
      );
      expect(secondHtml).not.toContain('http-equiv="refresh"');
    } finally {
      retrieve.restore();
    }
  });

  test("token-verified multi-listing success page suppresses thank-you URL", async () => {
    const { createTestAttendeeDirect } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );

    const listingA = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com/thanks-a",
      unitPrice: 1000,
    });
    const listingB = await createTestListing({
      maxAttendees: 10,
      thankYouUrl: "https://example.com/thanks-b",
      unitPrice: 1000,
    });

    const { attendee: attendeeA } = await createTestAttendeeDirect(
      listingA.id,
      "MultiA",
      "multia@example.com",
      1,
    );
    const { attendee: attendeeB } = await createTestAttendeeDirect(
      listingB.id,
      "MultiB",
      "multib@example.com",
      1,
    );
    const tokens = [attendeeA.ticket_token, attendeeB.ticket_token].join("+");

    const response = await routeRequest(
      mockRequest(`/payment/success?tokens=${encodeURIComponent(tokens)}`),
    );
    const html = await (response ?? new Response()).text();
    // Multiple listings: no single thank-you URL should be picked
    expect(html).not.toContain("https://example.com/thanks-a");
    expect(html).not.toContain("https://example.com/thanks-b");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  test("returns error for invalid tokens param", async () => {
    await expectInvalidCallback(
      await routeRequest(mockRequest("/payment/success?tokens=BOGUS")),
    );
  });
});
