/**
 * What a payment callback amounted to, and the one place that works it out.
 *
 * A provider tells us a checkout completed either through its webhook or,
 * for SumUp, through a recovery check that asks after the fact. Both need the
 * same answer to the same question — was this booked, is the money accounted
 * for, should we be asked again — so both run this, and neither decides money
 * for itself. The webhook turns the answer into an HTTP response; the
 * recovery task turns it into the event that moves its row along.
 */

import {
  isSessionRejection,
  type SessionRejection,
} from "#payment/validated-session.ts";
import {
  classifySessionIntent,
  type SessionIntentResult,
} from "#routes/api/payment-processing/classify.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { failureDetail } from "#routes/api/payment-processing/refunds.ts";
import { settleRejectedCharge } from "#routes/api/payment-processing/rejected-target.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type {
  ValidatedPaymentSession,
  WebhookSessionResult,
} from "#shared/payments.ts";

/** What the operator sees a log line came from. The two callers write the
 * same facts, and which one was running is the part that tells an operator
 * whether a customer was waiting on it. */
export type CallbackSource = "Recovery check" | "Webhook";

/** What a caller needs to answer and log one settled-but-unbooked callback.
 * `error` is what the provider is told; `detail` is diagnostic and is never
 * shown to a buyer. */
type CallbackFailure = {
  readonly detail: string;
  readonly error: string;
  readonly listingId: number | undefined;
};

/**
 * What one callback amounted to. Exhaustive, so every caller has to say what
 * it does about each answer rather than falling through to a default —
 * "nothing happened" and "the money is stuck" must never share an arm.
 */
export type CallbackOutcome =
  /** The provider's answer could not be used at all. Ask again. */
  | { readonly kind: "refused" }
  /** The payment is not complete, and the provider said so plainly. */
  | { readonly kind: "not_yet" }
  /** Resolved to a session that is not paid — worth recording, unlike the
   * provider simply saying "not yet". */
  | { readonly kind: "unpaid"; readonly detail: string }
  /** No session of ours answers to this. Nothing to do, ever. */
  | { readonly kind: "unrecognised" }
  /** Paid, but nothing proves it is ours, so we must not touch the money. */
  | { readonly kind: "unverifiable" }
  /** Ours and signed, but the booking could not be read. Ask again. */
  | { readonly kind: "unreadable" }
  /** Another request holds the reservation right now. Ask again. */
  | ({ readonly kind: "held" } & CallbackFailure)
  /** Booked, or already booked by an earlier delivery. */
  | {
      readonly kind: "booked";
      readonly listingId: number | undefined;
      readonly result: PaymentResult;
    }
  /** Not booked, and the money is accounted for — returned, or never taken. */
  | ({ readonly kind: "settled" } & CallbackFailure)
  /** Not booked, and a return that was needed did not go through. */
  | ({ readonly kind: "unsettled" } & CallbackFailure);

/** A rejected charge is chased for its money before anything else: settled
 * means nothing is left owing, and the two are kept apart because one moved
 * money and the other found nothing to move. */
const rejectionOutcome = async (
  rejection: SessionRejection,
  source: CallbackSource,
): Promise<CallbackOutcome> => {
  const outcome = await settleRejectedCharge(rejection);
  const detail = `${source} session rejected as ${rejection.reason} (refunded: ${outcome.refunded})`;
  const listingId = undefined;
  return outcome.settled
    ? { detail, error: "rejected", kind: "settled", listingId }
    : { detail, error: "Refund failed", kind: "unsettled", listingId };
};

/** What the engine's answer for a signed, readable booking amounted to. */
const processedOutcome = (
  result: PaymentResult,
  session: ValidatedPaymentSession,
  listingId: number | undefined,
): CallbackOutcome => {
  if (result.success) return { kind: "booked", listingId, result };
  const failure = {
    detail: failureDetail(result),
    error: result.error,
    listingId,
  };
  // A transient lock, not a money answer: nobody has decided anything yet.
  if (result.status === 409 && result.refunded === undefined) {
    return { ...failure, kind: "held" };
  }
  // A return was required and did not go through. Guarded on a payment
  // reference so a session with nothing to return cannot ask forever.
  if (result.refunded === false && session.paymentReference) {
    return { ...failure, kind: "unsettled" };
  }
  return { ...failure, kind: "settled" };
};

const classifiedOutcome = async (
  classified: SessionIntentResult,
  session: ValidatedPaymentSession,
): Promise<CallbackOutcome> => {
  if (classified.kind === "unverifiable") return { kind: "unverifiable" };
  if (classified.kind === "unreadable") return { kind: "unreadable" };
  const { intent, verdict } = classified;
  const listingId = intent.items[0]?.e;
  const result = await processPaymentSession(session.id, {
    intent,
    session,
    verdict,
  });
  return processedOutcome(result, session, listingId);
};

/**
 * Settle one payment callback: take the session the provider resolved and
 * carry it as far as it goes, returning what it amounted to.
 *
 * This never writes an HTTP response and never reads a request, so the
 * recovery task can run exactly what the webhook runs.
 */
export const settlePaymentCallback = async (
  resolved: WebhookSessionResult,
  source: CallbackSource,
): Promise<CallbackOutcome> => {
  if (resolved === "retry") return { kind: "refused" };
  if (resolved === "skip") return { kind: "not_yet" };
  // A charge the boundary could not read: a paid one is returned rather than
  // acknowledged into limbo, because the money was captured.
  if (isSessionRejection(resolved)) {
    return await rejectionOutcome(resolved, source);
  }
  if (!resolved) return { kind: "unrecognised" };
  // An unpaid session can still carry an amount that would classify as
  // trusted, so payment is confirmed before anything is classified.
  if (resolved.paymentStatus !== "paid") {
    return {
      detail: `${source} session not yet paid (status=${resolved.paymentStatus})`,
      kind: "unpaid",
    };
  }
  return await classifiedOutcome(
    await classifySessionIntent(resolved),
    resolved,
  );
};
