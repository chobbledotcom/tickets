/**
 * Whether a refund may be sent, given what the provider says has already
 * happened to the money.
 *
 * Every refund route asks this before it calls a provider, so "the money is
 * already back" and "a refund is already on its way" stop the call rather than
 * being discovered by making it. Stripe and Square would reject a second full
 * refund on their own, but SumUp carries no idempotency key, so a second call
 * there sends the money twice.
 */

import type { PaymentConflict } from "#shared/payment/conflict.ts";
import type { ObservationOutcome } from "#shared/payment/diagnose.ts";

/** What to do about a refund somebody asked for. Only `send` reaches a
 *  provider; the rest are answers we already have. */
export type RefundAdmission =
  | { issue: PaymentConflict; kind: "refused" }
  | { kind: "already_returned" }
  | { kind: "in_flight" }
  | { kind: "send" };

/** The answer for each way a reading can come out settled. Listing them
 *  exhaustively means a new outcome must say what it does about refunds here,
 *  rather than falling into whichever arm happens to be last. */
const ADMISSION_BY_OUTCOME = {
  fully_refunded: { kind: "already_returned" },
  ready: { kind: "send" },
  refund_pending: { kind: "in_flight" },
} as const satisfies Record<
  Exclude<ObservationOutcome, { kind: "conflict" }>["kind"],
  RefundAdmission
>;

/**
 * Turn what a reading came to into what to do about a refund. A problem the
 * owner has to look at never sends money: the reading and the booking disagree,
 * and sending more money into that disagreement is how one buyer is paid twice.
 */
export const admitRefund = (outcome: ObservationOutcome): RefundAdmission =>
  outcome.kind === "conflict"
    ? { issue: outcome.issue, kind: "refused" }
    : ADMISSION_BY_OUTCOME[outcome.kind];
