/**
 * What the money on a set of charges amounts to.
 *
 * The single place that judges what became of a refund, so a stored answer can
 * never disagree with the reading it claims to come from.
 */

import type { PaymentConflict } from "#payment/conflict.ts";
import { resolveRefund } from "#payment/refund.ts";
import {
  type ChargeMoney,
  refundMoneyMatchesCapture,
} from "#payment/resources.ts";

/** What a reading comes to once it has been looked at. Only "conflict" is a
 *  problem for the owner; the rest are where the payment has got to. */
export type ObservationOutcome =
  | { issue: PaymentConflict; kind: "conflict" }
  | { kind: "fully_refunded" }
  | { kind: "ready" }
  | { kind: "refund_pending" };

/** Any leg where the money back — or on its way — outruns the money taken, or
 *  where the two are not even in the same currency to compare. */
const refundOverspendsCapture = (charges: readonly ChargeMoney[]): boolean =>
  charges.some((charge) => !refundMoneyMatchesCapture(charge));

/** Money was taken and the reading has been checked, so all that is left is
 *  what became of any refunds on it. */
const refundOutcome = (charges: readonly ChargeMoney[]): ObservationOutcome => {
  const refunds = charges.map(resolveRefund);
  // Two live refunds cannot be assigned to this run, so the owner must settle
  // which attempt each provider event belongs to.
  if (
    refunds.some(
      (refund) =>
        refund.status === "failed" &&
        refund.reason === "multiple_pending_refunds",
    )
  ) {
    return {
      issue: { kind: "multiple_pending_refunds" },
      kind: "conflict",
    };
  }
  if (refunds.every((refund) => refund.status === "completed")) {
    return { kind: "fully_refunded" };
  }
  if (refunds.some((refund) => refund.status === "pending")) {
    return { kind: "refund_pending" };
  }
  // Any money back at all parks the booking: the provider is keeping less than
  // the signed total. Judged on the AMOUNT, not the status, because a refund
  // the provider could not finish still reports what came back before it
  // failed — sending again on top of that would pay the buyer twice. A failure
  // that moved nothing leaves the charge ready for a fresh attempt.
  return refunds.some((refund) => refund.amount.amount > 0)
    ? { issue: { kind: "partial_refund" }, kind: "conflict" }
    : { kind: "ready" };
};

/** What the money on these charges comes to on its own, with no agreed total
 *  behind it. A reference the site holds no signed price for cannot be judged
 *  on what was owed, so those kinds are not asked here rather than asked
 *  against a stand-in. The comparison that matters before sending money needs
 *  no total anyway: returned is measured against TAKEN. */
export const refundOutcomeOf = (
  charges: readonly ChargeMoney[],
): ObservationOutcome =>
  refundOverspendsCapture(charges)
    ? { issue: { kind: "refund_exceeds_capture" }, kind: "conflict" }
    : refundOutcome(charges);
