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

import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import {
  classifySessionIntent,
  paymentSessionErrorLogger,
} from "#routes/api/payment-processing/classify.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import {
  answerRejectedSession,
  failureDetail,
  refundRejectedCharge,
} from "#routes/api/payment-processing/refunds.ts";
import {
  handlePaymentSuccess,
  paymentSessionId,
} from "#routes/api/payment-success.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { jsonResponse, plainResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { t } from "#shared/i18n.ts";
import {
  ErrorCode,
  type ErrorCodeType,
  logDebug,
  logError,
} from "#shared/logger.ts";
import { isSessionRejection } from "#shared/payment/validated-session.ts";
import { WEBHOOK_SIGNATURE_HEADERS } from "#shared/payment-providers.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import {
  type ExistingPaymentProvider,
  getPaymentProviderForExistingPayments,
  type ValidatedPaymentSession,
  type WebhookEvent,
} from "#shared/payments.ts";

const getPaymentProviderOrLog = async (
  code: ErrorCodeType,
  detail: string,
  listingId?: number,
): Promise<ExistingPaymentProvider> => {
  const provider = await getPaymentProviderForExistingPayments();
  if (!provider) logError({ code, detail, listingId });
  return provider;
};

/** Wrap handler with session ID extraction */
const withSessionId =
  (handler: (sessionId: string) => Promise<Response>) =>
  (request: Request): Promise<Response> => {
    const sessionId = paymentSessionId(request);
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
 * Handle GET /payment/cancel (redirect after cancelled payment)
 *
 * No attendee cleanup needed - attendee is only created after successful payment.
 */
/** Log a payment session error with cancel context prefix */
const logCancelError = paymentSessionErrorLogger("cancel");

const handlePaymentCancel = withSessionId(async (sid) => {
  // A buyer who cancels may do so after the operator switched new sales off, so
  // resolve the provider that captured the payment rather than the new-sales gate.
  const provider = await getPaymentProviderForExistingPayments();
  if (!provider) {
    logCancelError(`No provider configured (session=${sid})`);
    return paymentErrorResponse("Payment provider not configured");
  }

  const session = await provider.retrieveSession(sid);
  // A buyer who cancelled can still land here on a charge the boundary could
  // not read, so this answers the same way the success redirect does.
  if (isSessionRejection(session)) {
    return answerRejectedSession(session, logCancelError);
  }
  if (!session) {
    logCancelError(`Session not found (session=${sid})`);
    return paymentErrorResponse(t("payment.error.session_not_found"));
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
  listingIdForLog: number | undefined,
): Response => {
  if (result.success) return webhookAckResponse({ processed: true });
  // Log once at the boundary — inner functions pass structured context via detail.
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: failureDetail(result),
    listingId: listingIdForLog,
  });
  logDebug("Webhook", "Payment callback processing failed");
  if (result.status === 409 && result.refunded === undefined) {
    return plainResponse(result.error, 409);
  }
  if (result.refunded === false && session.paymentReference) {
    return plainResponse(result.error, 503);
  }
  return webhookAckResponse({ error: result.error, processed: false });
};

/** Detect which provider sent the webhook based on request headers. Reads the
 * signature header of each provider that signs its webhooks (per the shared
 * registry) and returns the first one present. */
const getWebhookSignatureHeader = (request: Request): string | null =>
  WEBHOOK_SIGNATURE_HEADERS.map((header) => request.headers.get(header)).find(
    Boolean,
  ) ?? null;

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
    provider: NonNullable<ExistingPaymentProvider>;
    listing: WebhookEvent;
  }
> => {
  const provider = await getPaymentProviderOrLog(
    ErrorCode.PAYMENT_SESSION,
    "Webhook received but payment provider not configured",
  );
  if (!provider) {
    logDebug("Webhook", "Rejected webhook: payment provider not configured");
    return plainResponse("Payment provider not configured", 400);
  }

  const signature = getWebhookSignatureHeader(request) ?? "";
  if (provider.requiresWebhookSignature && !signature) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook missing signature header",
    });
    logDebug("Webhook", "Rejected webhook: missing signature");
    return plainResponse("Missing signature", 400);
  }

  // Use the public-facing domain for signature verification. Square signs the
  // webhook using the exact notification URL from the subscription, which is the
  // public https:// URL. Deriving from request.url fails behind CDNs that
  // terminate TLS (the edge runtime sees http:// instead of https://).
  const webhookUrl = getPaymentWebhookUrl();
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
    logDebug("Webhook", "Rejected webhook: signature verification failed");
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
  // (e.g. dynamic imports in getPaymentProviderForExistingPayments), causing "BadResource:
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

  if (sessionResult === "retry") {
    // Fixed, value-free refusal: a forged or unreadable callback must not
    // learn why verification failed or spend alert subrequests, and the
    // provider redelivers on a 503 where an acknowledgement is terminal.
    logDebug("Webhook", "Refused a payment callback retryably");
    return plainResponse("Payment verification failed", 503);
  }

  if (sessionResult === "skip") {
    return webhookAckResponse({ status: "pending" });
  }

  // A charge the boundary could not read: a paid one with a usable reference
  // is refunded rather than acked into limbo — the money was captured, so it
  // must not disappear. A blank-reference rejection cannot be refunded.
  if (isSessionRejection(sessionResult)) {
    const outcome = await refundRejectedCharge(sessionResult);
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail:
        `Webhook session rejected as ${sessionResult.reason} (refunded: ${outcome.refunded})`,
    });
    // A required refund that failed must retry: acknowledging would strand the
    // captured charge with no redelivery.
    if (!outcome.settled) return plainResponse("Refund failed", 503);
    return webhookAckResponse({ error: "rejected", processed: false });
  }

  if (!sessionResult) {
    logDebug("Webhook", "Ignoring webhook for unrecognized payment session");
    return webhookAckResponse();
  }

  const session = sessionResult;

  // Verify payment is complete before classifying — an unpaid session may carry
  // a charge amount that would otherwise classify as trusted.
  if (session.paymentStatus !== "paid") {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Webhook session not yet paid (status=${session.paymentStatus})`,
    });
    logDebug("Webhook", "Waiting for a completed payment");
    return webhookAckResponse({ status: "pending" });
  }

  // A valid price proof is the only signal that the session is ours: it cannot
  // be forged without our key, and our checkout always attaches one. Without it
  // we cannot prove ownership (a different application sharing the provider
  // account, or replayed/corrupt data), so we acknowledge without processing or
  // refunding — refunding an unverifiable session could refund another
  // instance's payment.
  const classified = await classifySessionIntent(session);
  switch (classified.kind) {
    case "unverifiable":
      logDebug("Webhook", "Ignoring webhook for unverifiable session");
      return webhookAckResponse();
    case "unreadable":
      logDebug("Webhook", "Refusing an unreadable signed booking retryably");
      return plainResponse("Payment verification failed", 503);
    case "ready":
      break;
  }

  const { intent, verdict } = classified;
  const listingIdForLog = intent.items[0]?.e;
  const result = await processPaymentSession(session.id, {
    intent,
    session,
    verdict,
  });
  return webhookResultResponse(result, session, listingIdForLog);
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
