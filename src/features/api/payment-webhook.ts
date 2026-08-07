import { classifyAttemptSession } from "#routes/api/payment-processing/classify.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import {
  failureDetail,
  refundRejectedCharge,
} from "#routes/api/payment-processing/refunds.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { jsonResponse, plainResponse } from "#routes/response.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { isSessionRejection } from "#shared/payment/validated-session.ts";
import {
  getExistingPaymentAttempt,
  type PaymentAttempt,
} from "#shared/payment-attempt.ts";
import { WEBHOOK_SIGNATURE_HEADERS } from "#shared/payment-providers.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import type {
  ValidatedPaymentSession,
  WebhookEvent,
} from "#shared/payments.ts";

/** Acknowledge a webhook after its outcome has been handled. */
const webhookAckResponse = (extra?: Record<string, unknown>): Response =>
  jsonResponse({ received: true, ...extra });

const webhookResultResponse = (
  result: PaymentResult,
  session: ValidatedPaymentSession,
  payload: string,
  listingIdForLog: number | undefined,
): Response => {
  if (result.success) return webhookAckResponse({ processed: true });
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: failureDetail(result),
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

const getWebhookSignatureHeader = (request: Request): string | null =>
  WEBHOOK_SIGNATURE_HEADERS.map((header) => request.headers.get(header)).find(
    Boolean,
  ) ?? null;

const authenticateWebhook = async (
  payload: string,
  payloadBytes: Uint8Array,
  request: Request,
): Promise<
  | Response
  | {
      attempt: PaymentAttempt;
      listing: WebhookEvent;
    }
> => {
  const attempt = await getExistingPaymentAttempt();
  if (!attempt) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook received but payment provider not configured",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Payment provider not configured", 400);
  }

  const signature = getWebhookSignatureHeader(request) ?? "";
  if (attempt.requiresWebhookSignature && !signature) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: "Webhook missing signature header",
    });
    logDebug("Webhook", `Rejected payload: ${payload}`);
    return plainResponse("Missing signature", 400);
  }

  // Square signs the public URL, not the edge runtime's internal request URL.
  const verification = await attempt.verifyWebhookSignature(
    payload,
    signature,
    getPaymentWebhookUrl(),
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

  return { attempt, listing: verification.listing };
};

/** Handle one payment-provider callback with one bound provider attempt. */
export const handlePaymentWebhook = async (
  request: Request,
): Promise<Response> => {
  // Bunny may release the request body while the provider module loads.
  const payloadBytes = new Uint8Array(await request.arrayBuffer());
  const payload = new TextDecoder().decode(payloadBytes);

  const auth = await authenticateWebhook(payload, payloadBytes, request);
  if (auth instanceof Response) return auth;
  const { attempt, listing } = auth;

  if (listing.type !== attempt.checkoutCompletedEventType) {
    return webhookAckResponse();
  }

  const sessionResult = await attempt.resolveWebhookSession(listing);
  if (sessionResult === "skip") {
    return webhookAckResponse({ status: "pending" });
  }

  if (isSessionRejection(sessionResult)) {
    const outcome = await refundRejectedCharge(attempt, sessionResult);
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Webhook session rejected as ${sessionResult.reason} (refunded: ${outcome.refunded})`,
    });
    return outcome.settled
      ? webhookAckResponse({ error: "rejected", processed: false })
      : plainResponse("Refund failed", 503);
  }

  if (!sessionResult) {
    logDebug(
      "Webhook",
      `Ignoring webhook for unrecognized payment session: ${payload}`,
    );
    return webhookAckResponse();
  }

  const session = sessionResult;
  if (session.paymentStatus !== "paid") {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Webhook session not yet paid (session=${session.id}, status=${session.paymentStatus})`,
    });
    logDebug("Webhook", `Pending payload: ${payload}`);
    return webhookAckResponse({ status: "pending" });
  }

  const classified = await classifyAttemptSession(
    () => {
      logDebug(
        "Webhook",
        `Ignoring webhook for unverifiable session (origin=${session.metadata._origin}): ${payload}`,
      );
      return webhookAckResponse();
    },
    attempt,
    session,
  );
  if (!classified.ok) return classified.response;

  const { intent, verdict } = classified.data;
  const result = await processPaymentSession(attempt, session.id, {
    intent,
    session,
    verdict,
  });
  return webhookResultResponse(result, session, payload, intent.items[0]?.e);
};
