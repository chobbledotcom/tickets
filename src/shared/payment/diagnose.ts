/**
 * What the money on a set of charges amounts to.
 *
 * The single place that judges what became of a refund, so a stored answer can
 * never disagree with the reading it claims to come from.
 */

import type { PaymentConflict } from "#shared/payment/conflict.ts";
import { resolveRefund } from "#shared/payment/refund.ts";
import type {
  ChargeMoney,
  RefundResolution,
} from "#shared/payment/resources.ts";
import { refundMoneyMatchesCapture } from "#shared/payment/resources.ts";

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

/** A refund the provider tried and could not finish. */
const providerCouldNotRefund = (refund: RefundResolution): boolean =>
  refund.status === "failed" && refund.reason === "provider_failed";

/** Money was taken and the reading has been checked, so all that is left is
 *  what became of any refunds on it. */
const refundOutcome = (charges: readonly ChargeMoney[]): ObservationOutcome => {
  const refunds = charges.map(resolveRefund);
  // No M4 reading can carry two refunds in flight: the only pending refund it
  // holds is the answer to its own single attempt, so seeing one means the
  // evidence is broken. M7's per-refund records turn this into a conflict.
  if (
    refunds.some(
      (refund) =>
        refund.status === "failed" &&
        refund.reason === "multiple_pending_refunds",
    )
  ) {
    throw new Error("An M4 reading cannot hold more than one refund in flight");
  }
  if (refunds.every((refund) => refund.status === "completed")) {
    return { kind: "fully_refunded" };
  }
  if (refunds.some((refund) => refund.status === "pending")) {
    return { kind: "refund_pending" };
  }
  if (refunds.some(providerCouldNotRefund)) {
    return { issue: { kind: "failed_refund" }, kind: "conflict" };
  }
  // Money back on SOME legs but not all is a partial refund of the booking
  // even when each leg's own refund finished: the provider is keeping less
  // than the signed total, so the booking parks for the owner.
  return refunds.some(
    (refund) => refund.status === "partial" || refund.status === "completed",
  )
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
