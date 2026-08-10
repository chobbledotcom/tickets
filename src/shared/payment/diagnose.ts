/**
 * What one reading of a payment amounts to, on its own.
 *
 * The single place that judges a reading: the resolver turns this into an
 * answer, and the check on a stored answer asks the same question of the
 * reading kept beside it. One implementation, so a stored problem can never
 * disagree with the reading it claims to come from.
 */

/* jscpd:ignore-start -- imports */
import type { PaymentConflict } from "#shared/payment/conflict.ts";
import type { PaymentObservation } from "#shared/payment/observation.ts";
import { resolveRefund } from "#shared/payment/refund.ts";
import type { ChargeLegs } from "#shared/payment/resources.ts";
import { refundMoneyMatchesCapture } from "#shared/payment/resources.ts";

/* jscpd:ignore-end */

type PaymentObservationCheck =
  | { valid: true }
  | { issue: PaymentConflict; valid: false };

const conflict = (issue: PaymentConflict): PaymentObservationCheck => ({
  issue,
  valid: false,
});

const moneyTotal = (charges: ChargeLegs): bigint =>
  charges.reduce((total, charge) => total + BigInt(charge.captured.amount), 0n);

const moneyCurrencies = (
  observation: PaymentObservation,
  charges: ChargeLegs,
): string[] => [
  observation.expected.currency,
  observation.providerTotal.currency,
  ...charges.flatMap((charge) => [
    charge.captured.currency,
    charge.confirmedRefunded.currency,
    ...charge.refunds.map((refund) => refund.amount.currency),
  ]),
];

const resourcesMatch = (
  observation: PaymentObservation,
  charges: ChargeLegs,
): boolean =>
  charges.every(
    (charge) =>
      charge.resource.provider === observation.session.provider &&
      charge.resource.parentId === observation.session.id &&
      charge.refunds.every(
        (refund) =>
          refund.refund === undefined ||
          (refund.refund.provider === charge.resource.provider &&
            refund.refund.parentId === charge.resource.id),
      ),
  );

const firstDuplicate = (values: string[]): string | undefined => {
  const seen = new Set<string>();
  return values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
};

const validatePaymentObservation = (
  observation: PaymentObservation,
): PaymentObservationCheck => {
  if (observation.providerTotal.currency !== observation.expected.currency) {
    return conflict({ kind: "currency_mismatch" });
  }
  if (observation.providerTotal.amount !== observation.expected.amount) {
    return conflict({ kind: "provider_total_mismatch" });
  }

  const charges = observation.charges;
  if (charges === undefined) return { valid: true };
  if (!resourcesMatch(observation, charges)) {
    return conflict({ kind: "resource_mismatch" });
  }
  if (
    moneyCurrencies(observation, charges).some(
      (currency) => currency !== observation.expected.currency,
    )
  ) {
    return conflict({ kind: "currency_mismatch" });
  }
  if (charges.some((charge) => !refundMoneyMatchesCapture(charge))) {
    return conflict({ kind: "refund_exceeds_capture" });
  }
  if (
    firstDuplicate(charges.map((charge) => charge.resource.id)) !== undefined
  ) {
    return conflict({ kind: "duplicate_charge" });
  }
  if (charges.length > 1) return conflict({ kind: "multiple_charges" });

  const captured = moneyTotal(charges);
  const expected = BigInt(observation.expected.amount);
  if (captured < expected) return conflict({ kind: "partial_charge" });
  if (captured !== expected) {
    return conflict({ kind: "capture_total_mismatch" });
  }
  return { valid: true };
};

/** What a reading comes to once it has been looked at. Only "conflict" is a
 *  problem for the owner; the rest are where the payment has got to. */
export type ObservationOutcome =
  | { issue: PaymentConflict; kind: "conflict" }
  | { kind: "fully_refunded" }
  | { kind: "ready" }
  | { kind: "refund_pending" };

/** A reading that has finished saying what happened to the money. A checkout
 *  still going, or one that failed, has not, and is answered before it gets
 *  here. */
export type SettledReading = PaymentObservation & {
  status: "no_payment_required" | "paid";
};

/** A refund the provider tried and could not finish. */
const providerCouldNotRefund = (refund: { reason?: string; status: string }) =>
  refund.status === "failed" && refund.reason === "provider_failed";

/** Money was taken and the reading has been checked, so all that is left is
 *  what became of any refunds on it. */
const refundOutcome = (charges: ChargeLegs): ObservationOutcome => {
  const refunds = charges.map(resolveRefund);
  // No M4 reading can carry two refunds in flight: the only pending refund an
  // observation holds is the direct answer to its own single attempt. Seeing
  // one means the evidence itself is broken, so fail loudly rather than
  // letting the reading pass as settled. M7's per-refund records turn this
  // into the judged `multiple_pending_refunds` conflict.
  if (
    refunds.some(
      (refund) =>
        refund.status === "failed" &&
        refund.reason === "multiple_pending_refunds",
    )
  ) {
    throw new Error("An M4 reading cannot hold more than one refund in flight");
  }
  if (refunds.some((refund) => refund.status === "completed")) {
    return { kind: "fully_refunded" };
  }
  if (refunds.some((refund) => refund.status === "pending")) {
    return { kind: "refund_pending" };
  }
  if (refunds.some(providerCouldNotRefund)) {
    return { issue: { kind: "failed_refund" }, kind: "conflict" };
  }
  return refunds.some((refund) => refund.status === "partial")
    ? { issue: { kind: "partial_refund" }, kind: "conflict" }
    : { kind: "ready" };
};

/** A checkout that took money: it must name the money it took, and the reading
 *  must hold together, before what became of any refund can matter. */
const paidOutcome = (observation: PaymentObservation): ObservationOutcome => {
  const charges = observation.charges;
  if (charges === undefined) {
    return { issue: { kind: "paid_without_charge" }, kind: "conflict" };
  }
  const checked = validatePaymentObservation(observation);
  return checked.valid
    ? refundOutcome(charges)
    : { issue: checked.issue, kind: "conflict" };
};

/** A checkout that asked for nothing. The check above already refused any
 *  reading whose provider total differs from what was asked for, so nothing
 *  asked for means nothing taken. */
const freeOutcome = (observation: PaymentObservation): ObservationOutcome => {
  const checked = validatePaymentObservation(observation);
  if (!checked.valid) return { issue: checked.issue, kind: "conflict" };
  return observation.expected.amount === 0 && observation.charges === undefined
    ? { kind: "ready" }
    : { issue: { kind: "paid_without_charge" }, kind: "conflict" };
};

/** What this reading amounts to. */
export const outcomeOf = (observation: SettledReading): ObservationOutcome =>
  observation.status === "paid"
    ? paidOutcome(observation)
    : freeOutcome(observation);

/** Whether this reading has finished saying what happened to the money. A
 *  stored answer about one that has not is asking about nothing yet. */
export const hasSettled = (
  observation: PaymentObservation,
): observation is SettledReading =>
  observation.status === "paid" || observation.status === "no_payment_required";
