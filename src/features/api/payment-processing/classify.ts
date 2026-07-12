/**
 * The validate step of the payment machine: confirm with the provider that a
 * session is paid, then prove — via its signed price proof — that the session is
 * ours before anything downstream processes or refunds it.
 */

import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import { extractIntent } from "#routes/api/payment-processing/metadata.ts";
import type {
  SessionValidation,
  SignedVerdict,
} from "#routes/api/webhook-types.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { discardPendingCheckoutSessions } from "#shared/db/checkout-stages.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { verifyPrice } from "#shared/payment-signature.ts";
import {
  getActivePaymentProvider,
  type ValidatedPaymentSession,
} from "#shared/payments.ts";

/** Log a payment session error with redirect context prefix */
export const logRedirectError = (detail: string): void =>
  logError({ code: ErrorCode.PAYMENT_SESSION, detail: `[redirect] ${detail}` });

/** Split the `total.sig` price proof into a non-negative integer total and a
 * non-empty signature, or null when the field is absent or malformed. */
const parsePriceProof = (
  proof: string,
): { total: number; sig: string } | null => {
  const match = /^(\d+)\.(.+)$/.exec(proof);
  return match ? { sig: match[2]!, total: Number(match[1]) } : null;
};

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
  return session.amountTotal === evaluation.total
    ? { agreed: evaluation.total, verdict: "trusted" }
    : { agreed: evaluation.total, verdict: "mismatch" };
};

export const validatePaidSession = async (
  sessionId: string,
): Promise<SessionValidation> => {
  const provider = await getActivePaymentProvider();
  if (!provider) {
    logRedirectError(`No payment provider configured (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment provider not configured"),
    };
  }

  const session = await provider.retrieveSession(sessionId);
  if (!session) {
    logRedirectError(`Session not found (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not found"),
    };
  }

  // Declined or expired checkout: SumUp's hosted page has a single redirect
  // URL for every outcome, so a card decline lands here. Show the friendly
  // cancel/try-again page, not a "contact support" error.
  if (session.paymentStatus === "failed") {
    await discardPendingCheckoutSessions([sessionId]);
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
  const verdict = await classifySession(session);
  if (verdict.verdict === "ignore") {
    logRedirectError(`Unrecognized payment session (session=${sessionId})`);
    return {
      ok: false,
      response: paymentErrorResponse("Payment session not recognized"),
    };
  }
  // A valid proof means the metadata is byte-for-byte what we signed, so the
  // intent always parses — extractIntent only returns null on metadata we never
  // produced.
  const intent = extractIntent(session)!;
  return { data: { intent, session, verdict }, ok: true };
};
