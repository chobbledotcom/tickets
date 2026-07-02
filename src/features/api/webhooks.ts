/**
 * Webhook routes - payment callbacks and provider webhooks
 *
 * Payment flow (race-condition safe with two-phase locking):
 * 1. User submits form -> checkout session created with intent metadata (no attendee yet)
 * 2. User pays -> redirected to /payment/success OR webhook fires
 * 3. First handler reserves session (DB lock), creates attendee, finalizes lock
 * 4. Subsequent handlers see reserved/finalized session and return existing attendee
 * 5. If capacity exceeded after payment, auto-refund and show error
 *
 * Security:
 * - Webhooks are verified using provider-specific signature verification
 * - Session ID alone cannot create attendees - provider API confirms payment status
 * - Two-phase locking prevents duplicate attendee creation from race conditions
 */

import { unique } from "#fp";
import {
  cancelPageResponse,
  classifySession,
  extractIntent,
  formatPaymentError,
  processPaymentSession,
  validatePaidSession,
} from "#routes/api/payment-processing.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { getFromEmailIfConfigured } from "#routes/public/ticket-routes.ts";
import {
  htmlResponse,
  jsonResponse,
  paymentErrorResponse,
  plainResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  parseTokens,
  verifyTokensWithRealLine,
} from "#routes/tickets/token-utils.ts";
import { getSearchParam } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { getHiddenPackageMemberIds } from "#shared/db/groups.ts";
import { getListing } from "#shared/db/listings.ts";
import { clearSessionTokens } from "#shared/db/processed-payments.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  getActivePaymentProvider,
  type ValidatedPaymentSession,
  type WebhookEvent,
} from "#shared/payments.ts";
import { successPage } from "#templates/payment.tsx";

/** Wrap handler with session ID extraction */
const withSessionId =
  (handler: (sessionId: string) => Promise<Response>) =>
  (request: Request): Promise<Response> => {
    const sessionId = getSearchParam(request, "session_id");
    if (!sessionId) {
      logError({
        code: ErrorCode.PAYMENT_SESSION,
        detail: "Payment callback missing session_id parameter",
      });
    }
    return sessionId
      ? handler(sessionId)
      : Promise.resolve(paymentErrorResponse("Invalid payment callback"));
  };

/**
 * Process session_id param: validate, create attendee, redirect with tokens.
 */
/** The thank-you redirect for a single-listing purchase, or "" when there is no
 * URL — suppressed entirely when the listing is a HIDDEN package's member. Its
 * `thank_you_url` would meta-refresh the success page to a listing the package
 * concealed, exposing it to a buyer who only ever saw the package name (the same
 * privacy invariant the signed-intent/free-redirect guard upholds, here for the
 * paid single-member fallback both success render paths share). */
const singleListingThankYou = async (listingId: number): Promise<string> => {
  if ((await getHiddenPackageMemberIds([listingId])).size > 0) return "";
  const listing = await getListing(listingId);
  return listing?.thank_you_url.trim() ?? "";
};

const processSessionAndRedirect = async (
  sessionId: string,
): Promise<Response> => {
  const validation = await validatePaidSession(sessionId);
  if (!validation.ok) return validation.response;

  // A parent booking carries an explicit thank-you URL through its signed
  // metadata so folding a child (which makes the order multi-listing) doesn't
  // drop the parent's configured redirect. The token-derive render keys off the
  // booked listing ids, so it can't recover that URL once >1 listing is booked
  // — that path renders the success page directly here (below), where the
  // verified intent still holds it, rather than redirecting to the token path.
  const explicitThankYou = validation.data.intent.thankYouUrl ?? "";

  // Token persistence diverges by render path. The redirect path skips persisting
  // (the tokens go in the URL, so storing them would leave them in the DB forever
  // when the redirect wins the race). The direct-render path (explicit thank-you
  // URL) does NOT put the tokens in a URL, so it MUST persist them — otherwise a
  // reload hits the already-processed branch with no stored token and the buyer
  // loses the ticket link.
  const result = await processPaymentSession(sessionId, validation.data, {
    storeTokens: explicitThankYou !== "",
  });

  if (!result.success) {
    // Log once at the redirect boundary
    const listingId = validation.data.intent.items[0]?.e;
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[redirect] ${result.detail ?? result.error}`,
      listingId,
    });
    return paymentErrorResponse(formatPaymentError(result), result.status);
  }

  // Direct-render path: render the success page here (with the ticket URL drawn
  // from the persisted/just-created tokens) so the parent's thank-you URL is
  // honoured and a reload still finds the token in the DB.
  if (explicitThankYou && result.ticketTokens.length > 0) {
    const fromEmail = await getFromEmailIfConfigured();
    return htmlResponse(
      successPage({
        fromEmail,
        paid: true,
        thankYouUrl: explicitThankYou,
        ticketUrl: `/t/${result.ticketTokens.join("+")}`,
      }),
    );
  }

  // Redirect path: the tokens go in the URL, so clear any a racing webhook stored
  // (consumed now via the redirect URL), then redirect.
  // encodeURIComponent preserves + as %2B so URLSearchParams.get() decodes it back correctly
  if (result.ticketTokens.length > 0) {
    await clearSessionTokens(sessionId);
    return redirectResponse(
      `/payment/success?tokens=${encodeURIComponent(
        result.ticketTokens.join("+"),
      )}`,
    );
  }

  // Already-processed session (no tokens available) - render directly. An
  // explicit (parent) thank-you URL from the intent wins; otherwise resolve the
  // listing lazily (the only place a thank-you URL is needed) so the webhook
  // path never loads it; a since-deleted listing simply yields no URL.
  let thankYouUrl = explicitThankYou;
  if (!thankYouUrl && validation.data.intent.items.length === 1) {
    thankYouUrl = await singleListingThankYou(result.listingId);
  }
  return htmlResponse(
    successPage({ paid: true, thankYouUrl, ticketUrl: null }),
  );
};

/**
 * Render success page from verified tokens param.
 */
const renderSuccessFromTokens = async (
  tokensParam: string,
): Promise<Response> => {
  const tokens = parseTokens(tokensParam);
  // Only tokens with a real (quantity > 0) line are valid: an all-ghost token's
  // /t link would 404, and a ghost line must not inflate the single-listing
  // thank-you check.
  const { verifiedTokens, listingIds } = await verifyTokensWithRealLine(tokens);

  if (verifiedTokens.length === 0) {
    return paymentErrorResponse("Invalid payment callback");
  }

  const ticketUrl = `/t/${verifiedTokens.join("+")}`;

  // Only use thank_you_url for single-listing purchases — and never for a hidden
  // package's sole member, whose URL would reveal the listing it concealed.
  const uniqueListingIds = unique(listingIds);
  const thankYouUrl =
    uniqueListingIds.length === 1
      ? await singleListingThankYou(uniqueListingIds[0]!)
      : "";

  const fromEmail = await getFromEmailIfConfigured();

  return htmlResponse(
    successPage({ fromEmail, paid: true, thankYouUrl, ticketUrl }),
  );
};

/**
 * Handle GET /payment/success (redirect after successful payment)
 *
 * Two-phase flow:
 * 1. With session_id: process payment, create attendee, redirect with tokens
 * 2. With tokens: verify tokens against DB, render success page with ticket link
 */
const handlePaymentSuccess = (request: Request): Promise<Response> => {
  // Stripe uses session_id via {CHECKOUT_SESSION_ID} template variable;
  // Square appends orderId as a query parameter to the redirect URL
  const sessionId =
    getSearchParam(request, "session_id") || getSearchParam(request, "orderId");
  if (sessionId) return processSessionAndRedirect(sessionId);

  const tokensParam = getSearchParam(request, "tokens");
  if (tokensParam) return renderSuccessFromTokens(tokensParam);

  const url = new URL(request.url);
  const paramKeys = [...url.searchParams.keys()].join(",") || "none";
  const referer = request.headers.get("referer") ?? "none";
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: `Payment success callback with no session_id or tokens | params=[${paramKeys}] referer=${referer}`,
  });
  return Promise.resolve(paymentErrorResponse("Invalid payment callback"));
};

/**
 * Handle GET /payment/cancel (redirect after cancelled payment)
 *
 * No attendee cleanup needed - attendee is only created after successful payment.
 */
/** Log a payment session error with cancel context prefix */
const logCancelError = (detail: string): void =>
  logError({ code: ErrorCode.PAYMENT_SESSION, detail: `[cancel] ${detail}` });

const handlePaymentCancel = withSessionId(async (sid) => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    logCancelError(`No provider configured (session=${sid})`);
    return paymentErrorResponse("Payment provider not configured");
  }

  const session = await provider.retrieveSession(sid);
  if (!session) {
    logCancelError(`Session not found (session=${sid})`);
    return paymentErrorResponse("Payment session not found");
  }

  return cancelPageResponse(session, logCancelError);
});

/**
 * =============================================================================
 * Payment Webhook Endpoint
 * =============================================================================
 * Handles listings directly from payment providers with signature verification.
 */

/** JSON response acknowledging a webhook listing.
 * Always returns 200 so payment providers don't retry — we've already
 * handled the outcome (logged, refunded, etc.). Error details are in the body. */
const webhookAckResponse = (extra?: Record<string, unknown>): Response =>
  jsonResponse({ received: true, ...extra });

/**
 * Map a processed-payment result to the webhook's HTTP response.
 *  - success → 200 ack (processed).
 *  - another request holds the reservation (transient lock, no refund) → 409 so
 *    the provider retries.
 *  - a refund of a real payment failed → 503 (reservation left retryable) so the
 *    provider re-delivers and we re-attempt; guarded on a payment reference so a
 *    session with nothing to refund can't trigger a retry loop.
 *  - any other handled failure (refund issued, or nothing to retry) → 200 ack.
 */
const webhookResultResponse = (
  result: PaymentResult,
  session: ValidatedPaymentSession,
  payload: string,
  listingIdForLog: number | undefined,
): Response => {
  if (result.success) return webhookAckResponse({ processed: true });
  // Log once at the boundary — inner functions pass structured context via detail.
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: result.detail ?? result.error,
    listingId: listingIdForLog,
  });
  logDebug("Webhook", `Failed payload: ${payload}`);
  if (result.status === 409 && result.refunded === undefined) {
    return plainResponse(result.error, 409);
  }
  if (result.refunded === false && session.paymentReference) {
    return plainResponse(result.error, 503);
  }
  return webhookAckResponse({ error: result.error, processed: false });
};

/** Detect which provider sent the webhook based on request headers */
const getWebhookSignatureHeader = (request: Request): string | null =>
  request.headers.get("stripe-signature") ??
  request.headers.get("x-square-hmacsha256-signature") ??
  null;

/**
 * Authenticate an incoming webhook: resolve the provider, require the signature
 * header when the provider needs one, and verify signature/payload integrity.
 * Returns the verified listing + provider on success, or a Response to short-
 * circuit the request on failure.
 */
const authenticateWebhook = async (
  request: Request,
  payload: string,
  payloadBytes: Uint8Array,
): Promise<
  | Response
  | {
      provider: NonNullable<
        Awaited<ReturnType<typeof getActivePaymentProvider>>
      >;
      listing: WebhookEvent;
    }
> => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook received but payment provider not configured",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Payment provider not configured", 400);
  }

  const signature = getWebhookSignatureHeader(request) ?? "";
  if (provider.requiresWebhookSignature && !signature) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook missing signature header",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Missing signature", 400);
  }

  // Use the public-facing domain for signature verification. Square signs the
  // webhook using the exact notification URL from the subscription, which is the
  // public https:// URL. Deriving from request.url fails behind CDNs that
  // terminate TLS (the edge runtime sees http:// instead of https://).
  const webhookUrl = `https://${getEffectiveDomain()}/payment/webhook`;
  const verification = await provider.verifyWebhookSignature(
    payload,
    signature,
    webhookUrl,
    payloadBytes,
  );
  if (!verification.valid) {
    logError({
      code: ErrorCode.PAYMENT_SIGNATURE,
      detail: `Webhook signature verification failed: ${verification.error}`,
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse(verification.error, 400);
  }

  return { listing: verification.listing, provider };
};

/**
 * Handle POST /payment/webhook (payment provider webhook endpoint)
 *
 * Receives listings directly from the payment provider with signature verification.
 * Primary handler for payment completion - more reliable than redirects.
 */
const handlePaymentWebhook = async (request: Request): Promise<Response> => {
  // Read raw body bytes FIRST, before any async work. The Bunny Edge runtime
  // can garbage-collect the underlying request body resource during awaits
  // (e.g. dynamic imports in getActivePaymentProvider), causing "BadResource:
  // Cannot read body as underlying resource unavailable" errors.
  const payloadBytes = new Uint8Array(await request.arrayBuffer());
  const payload = new TextDecoder().decode(payloadBytes);

  const auth = await authenticateWebhook(request, payload, payloadBytes);
  if (auth instanceof Response) return auth;
  const { provider, listing } = auth;

  // Only handle checkout completed listings
  if (listing.type !== provider.checkoutCompletedEventType) {
    // Acknowledge other listings without processing
    return webhookAckResponse();
  }

  // Delegate session extraction to the provider — each provider knows how to
  // resolve a session from its own webhook listing structure.
  const sessionResult = await provider.resolveWebhookSession(listing);

  if (sessionResult === "skip") {
    return webhookAckResponse({ status: "pending" });
  }

  if (!sessionResult) {
    logDebug(
      "Webhook",
      `Ignoring webhook for unrecognized payment session: ${payload}`,
    );
    return webhookAckResponse();
  }

  const session = sessionResult;

  // Verify payment is complete before classifying — an unpaid session may carry
  // a charge amount that would otherwise classify as trusted.
  if (session.paymentStatus !== "paid") {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Webhook session not yet paid (session=${session.id}, status=${session.paymentStatus})`,
    });
    logDebug("Webhook", `Pending payload: ${payload}`);
    return webhookAckResponse({ status: "pending" });
  }

  // A valid price proof is the only signal that the session is ours: it cannot
  // be forged without our key, and our checkout always attaches one. Without it
  // we cannot prove ownership (a different application sharing the provider
  // account, or replayed/corrupt data), so we acknowledge without processing or
  // refunding — refunding an unverifiable session could refund another
  // instance's payment.
  const verdict = await classifySession(session);
  if (verdict.verdict === "ignore") {
    logDebug(
      "Webhook",
      `Ignoring webhook for unverifiable session (origin=${session.metadata._origin}): ${payload}`,
    );
    return webhookAckResponse();
  }

  // A valid proof means the metadata is byte-for-byte what we signed, so the
  // intent always parses — extractIntent only returns null on metadata we never
  // produced.
  const intent = extractIntent(session)!;
  const listingIdForLog = intent.items[0]?.e;
  const result = await processPaymentSession(session.id, {
    intent,
    session,
    verdict,
  });
  return webhookResultResponse(result, session, payload, listingIdForLog);
};

/** Payment routes definition */
const paymentRoutes = defineRoutes({
  "GET /payment/cancel": handlePaymentCancel,
  "GET /payment/success": handlePaymentSuccess,
  "POST /payment/webhook": handlePaymentWebhook,
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
