/**
 * The success redirect and the webhook race each other, so both go through
 * two-phase locking: the first handler reserves the session under a DB lock,
 * creates the attendee, then finalizes. A later handler sees the reserved or
 * finalized session and returns the existing attendee.
 *
 * A session id alone can never create an attendee. The provider API confirms
 * the payment first.
 */

import { t } from "#i18n";
import { isSessionRejection } from "#payment/validated-session.ts";
import {
  type CallbackOutcome,
  settlePaymentCallback,
} from "#routes/api/payment-callback.ts";
import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import { paymentSessionErrorLogger } from "#routes/api/payment-processing/classify.ts";
import { answerRejectedSession } from "#routes/api/payment-processing/rejected-target.ts";
import {
  handlePaymentSuccess,
  paymentSessionId,
} from "#routes/api/payment-success.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { jsonResponse, plainResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  ErrorCode,
  type ErrorCodeType,
  logDebug,
  logError,
} from "#shared/logger.ts";
import {
  providerWebhook,
  WEBHOOK_SIGNATURE_HEADERS,
} from "#shared/payment-providers.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import {
  type ExistingPaymentProvider,
  getPaymentProviderForExistingPayments,
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

/** The answers that carry nothing from the outcome but its kind. Exhaustive
 * over everything except the three that report an error, so a new outcome
 * stops this compiling until someone says what the provider is told. */
const PLAIN_RESPONSES: Record<
  Exclude<CallbackOutcome["kind"], "held" | "settled" | "unsettled">,
  () => Response
> = {
  booked: () => webhookAckResponse({ processed: true }),
  not_yet: () => webhookAckResponse({ status: "pending" }),
  refused: () => plainResponse("Payment verification failed", 503),
  unpaid: () => webhookAckResponse({ status: "pending" }),
  unreadable: () => plainResponse("Payment verification failed", 503),
  unrecognised: () => webhookAckResponse(),
  unverifiable: () => webhookAckResponse(),
};

/** Turn what a callback amounted to into the answer the provider gets.
 *
 * A 200 is terminal — the provider stops telling us — so it is only ever
 * given where nothing is left owing. Anything still owed, or still unknown,
 * answers 503 or 409 so the provider tells us again.
 */
const callbackResponse = (outcome: CallbackOutcome): Response => {
  switch (outcome.kind) {
    case "held":
      return plainResponse(outcome.error, 409);
    case "unsettled":
      return plainResponse(outcome.error, 503);
    case "settled":
      return webhookAckResponse({ error: outcome.error, processed: false });
    default:
      return PLAIN_RESPONSES[outcome.kind]();
  }
};

/** The one line a callback worth recording writes, and the console note that
 * goes with it. Outcomes carrying no detail are ordinary traffic. */
const logCallbackOutcome = (outcome: CallbackOutcome): void => {
  if ("detail" in outcome) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: outcome.detail,
      ...("listingId" in outcome ? { listingId: outcome.listingId } : {}),
    });
  }
  logDebug("Webhook", CALLBACK_NOTES[outcome.kind]);
};

/** What each answer is called in the debug log. Fixed words: a forged or
 * unreadable callback must not learn why it was refused. */
const CALLBACK_NOTES: Record<CallbackOutcome["kind"], string> = {
  booked: "Payment callback booked",
  held: "Payment callback is being processed elsewhere",
  not_yet: "Waiting for a completed payment",
  refused: "Refused a payment callback retryably",
  settled: "Payment callback settled without a booking",
  unpaid: "Waiting for a completed payment",
  unreadable: "Refusing an unreadable signed booking retryably",
  unrecognised: "Ignoring webhook for unrecognized payment session",
  unsettled: "Payment callback left money unaccounted for",
  unverifiable: "Ignoring webhook for unverifiable session",
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
  if (providerWebhook(provider.type) !== null && !signature) {
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
  // resolve a session from its own webhook listing structure — then settle it
  // through the engine the SumUp recovery task also runs.
  const outcome = await settlePaymentCallback(
    await provider.resolveWebhookSession(listing),
    "Webhook",
  );
  logCallbackOutcome(outcome);
  return callbackResponse(outcome);
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
