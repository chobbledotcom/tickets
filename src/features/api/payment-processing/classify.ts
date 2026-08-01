/**
 * The validate step of the payment machine: confirm with the provider that a
 * session is paid, then prove — via its signed price proof — that the session is
 * ours before anything downstream processes or refunds it.
 */

/* jscpd:ignore-start -- import block */
import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import { extractIntent } from "#routes/api/payment-processing/metadata.ts";
import { refundRejectedSession } from "#routes/api/payment-processing/refunds.ts";
import type {
  SessionValidation,
  SignedVerdict,
} from "#routes/api/webhook-types.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { isSessionRejection } from "#shared/payment/validated-session.ts";
import { parsePriceProof, verifyPrice } from "#shared/payment-signature.ts";
import {
  getPaymentProviderForExistingPayments,
  type ValidatedPaymentSession,
} from "#shared/payments.ts";
/* jscpd:ignore-end */

/** Makes a logger that records a payment-session error, prefixed with the
 * payment step it happened on (e.g. "redirect", "cancel"). */
export const paymentSessionErrorLogger =
  (step: string): ((detail: string) => void) =>
  (detail: string): void =>
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `[${step}] ${detail}`,
    });

/** Log a payment session error with redirect context prefix */
const logRedirectError = paymentSessionErrorLogger("redirect");

/** A session that could not be read: log why and return the shared refusal. */
const sessionUnavailable = (
  sessionId: string,
  why: string,
  status = 400,
): SessionValidation => {
  logRedirectError(`Session ${why} (session=${sessionId})`);
  return {
    ok: false,
    response: paymentErrorResponse("Payment session not found", status),
  };
};

/** Raise a checkout we can prove is ours but whose booking will not read. */
const logUnreadableBooking = paymentSessionErrorLogger("booking");

/**
 * Evaluate a session's price proof against its metadata:
 *  - `null`: no proof at all.
 *  - `{ valid: false }`: a proof is present but doesn't verify (tampered
 *    metadata, or a foreign instance that signed with its own key).
 *  - `{ valid: true, total }`: a genuine proof binding `total`.
 *
 * Only the third case proves the session is ours; the first two both classify as
 * `ignore` (see {@link classifySession}).
 */
const evaluatePriceProof = async (
  session: ValidatedPaymentSession,
): Promise<null | { valid: false } | { valid: true; total: number }> => {
  const proof = session.metadata.price_proof;
  if (!proof) return null;
  const parsed = parsePriceProof(proof);
  if (
    parsed === null ||
    !(await verifyPrice(session.metadata, parsed.total, parsed.sig))
  ) {
    return { valid: false };
  }
  return { total: parsed.total, valid: true };
};

/**
 * The single classification of a paid session — the one place the trust matrix
 * lives, so every downstream decision reads one verdict. A valid price proof is
 * the *only* signal that a session is ours: it cannot be forged without our key,
 * and our checkout always attaches one, so the `_origin` marker plays no part in
 * the decision (it is unsigned and forgeable).
 *
 *  - `trusted` — valid proof and the charge matches the signed total: process,
 *    using `agreed` as the price oracle.
 *  - `mismatch` — valid proof but the provider charged a different amount than we
 *    signed: refund (defensive — we create the checkout with the exact total).
 *  - `ignore` — no valid proof (absent, malformed, tampered, or signed by another
 *    instance). We cannot prove it is ours, so we neither process nor refund it:
 *    refunding an unverifiable session could refund another instance's payment,
 *    and a corrupted one of ours is a support case, not an automatic refund.
 */
type SessionClass = SignedVerdict | { verdict: "ignore" };

export const classifySession = async (
  session: ValidatedPaymentSession,
): Promise<SessionClass> => {
  const evaluation = await evaluatePriceProof(session);
  if (evaluation === null || !evaluation.valid) return { verdict: "ignore" };
  // A charge in a currency other than the site's cannot be honored at the
  // signed total — the amount is in the wrong unit — so it is refused like any
  // other mismatch and refunded rather than dropped.
  if (session.currency !== settings.currency.toUpperCase()) {
    return { agreed: evaluation.total, verdict: "mismatch" };
  }
  return session.amountTotal === evaluation.total
    ? { agreed: evaluation.total, verdict: "trusted" }
    : { agreed: evaluation.total, verdict: "mismatch" };
};

/** The booking a paid session carries, or null when we cannot act on it.
 *  Both nulls stop the session, but only one is quiet: a proof that does not
 *  verify may not be ours, while one that does means the buyer was charged,
 *  so a booking nothing can read is raised for the owner. */
export const classifySessionIntent = async (
  session: ValidatedPaymentSession,
): Promise<{ verdict: SignedVerdict; intent: BookingIntent } | null> => {
  const verdict = await classifySession(session);
  if (verdict.verdict === "ignore") return null;
  const intent = extractIntent(session);
  if (intent === null) {
    logUnreadableBooking(
      `Signed session's booking could not be read (session=${session.id})`,
    );
    return null;
  }
  return { intent, verdict };
};

export const validatePaidSession = async (
  sessionId: string,
): Promise<SessionValidation> => {
  // An in-flight checkout may complete after the operator switched new sales
  // off, so resolve the provider that captured the payment rather than the
  // new-sales gate.
  const provider = await getPaymentProviderForExistingPayments();
  if (!provider) {
    logRedirectError(`No payment provider configured (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment provider not configured"),
    };
  }

  const session = await provider.retrieveSession(sessionId);
  // A charge the boundary could not read: refund a paid one with a usable
  // reference so the captured money never disappears, then tell the buyer. A
  // failed refund is a retryable failure, so revisiting the redirect
  // re-attempts it.
  if (isSessionRejection(session)) {
    return sessionUnavailable(
      sessionId,
      `rejected as ${session.reason}`,
      (await refundRejectedSession(session)).status,
    );
  }
  if (!session) {
    return sessionUnavailable(sessionId, "not found");
  }

  // Declined or expired checkout: SumUp's hosted page has a single redirect
  // URL for every outcome, so a card decline lands here. Show the friendly
  // cancel/try-again page, not a "contact support" error.
  if (session.paymentStatus === "failed") {
    return {
      ok: false,
      response: await cancelPageResponse(session, logRedirectError),
    };
  }

  if (session.paymentStatus !== "paid") {
    logRedirectError(
      `Payment not verified as paid (session=${sessionId}, status=${session.paymentStatus})`,
    );
    return {
      ok: false,
      response: paymentErrorResponse(
        "Payment verification failed. Please contact support.",
      ),
    };
  }

  // Only a session carrying a valid price proof is provably ours. Without one we
  // cannot prove ownership (foreign instance sharing the provider, replayed or
  // corrupt data), so we neither process nor refund it — refunding an
  // unverifiable session could refund another instance's payment.
  const classified = await classifySessionIntent(session);
  if (classified === null) {
    logRedirectError(`Unrecognized payment session (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not recognized"),
    };
  }
  return { data: { session, ...classified }, ok: true };
};
