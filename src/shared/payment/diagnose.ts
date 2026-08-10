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
import type {
  ChargeLegs,
  ChargeMoney,
  RefundResolution,
} from "#shared/payment/resources.ts";
import { refundMoneyMatchesCapture } from "#shared/payment/resources.ts";

/* jscpd:ignore-end */

type PaymentObservationCheck =
  | { valid: true }
  | { issue: PaymentConflict; valid: false };

const conflict = (issue: PaymentConflict): PaymentObservationCheck => ({
  issue,
  valid: false,
});

const capturedTotal = (charges: ChargeLegs): bigint =>
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

/** Any leg where the money back — or on its way — outruns the money taken, or
 *  where the two are not even in the same currency to compare. */
const refundOverspendsCapture = (charges: readonly ChargeMoney[]): boolean =>
  charges.some((charge) => !refundMoneyMatchesCapture(charge));

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
  if (refundOverspendsCapture(charges)) {
    return conflict({ kind: "refund_exceeds_capture" });
  }
  if (
    firstDuplicate(charges.map((charge) => charge.resource.id)) !== undefined
  ) {
    return conflict({ kind: "duplicate_charge" });
  }
  return capturedTotal(charges) < BigInt(observation.expected.amount)
    ? conflict({ kind: "partial_charge" })
    : { valid: true };
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

/** The problem the shared check finds in this reading, or nothing when it
 *  holds together. Both arms ask it the same way. */
const readingProblemOrNull = (
  observation: PaymentObservation,
): ObservationOutcome | null => {
  const checked = validatePaymentObservation(observation);
  return checked.valid ? null : { issue: checked.issue, kind: "conflict" };
};

/** A refund the provider tried and could not finish. */
const providerCouldNotRefund = (refund: RefundResolution): boolean =>
  refund.status === "failed" && refund.reason === "provider_failed";

/** Money was taken and the reading has been checked, so all that is left is
 *  what became of any refunds on it. */
const refundOutcome = (charges: readonly ChargeMoney[]): ObservationOutcome => {
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

/** Money where this reading cannot account for it: nobody asked for it, and
 *  nothing can match it to what was bought. */
const moneyNobodyAskedFor: ObservationOutcome = {
  issue: { kind: "paid_without_charge" },
  kind: "conflict",
};

/** What a checked paid reading comes to: what became of its refunds first,
 *  then the owner-review money kinds. A leg that was part-refunded parks as
 *  `partial_refund` rather than being named by its leg count, so only a
 *  reading whose money is all still with the provider reaches the last two. */
const paidSettled = (
  observation: PaymentObservation,
  charges: ChargeLegs,
): ObservationOutcome => {
  const refunds = refundOutcome(charges);
  if (refunds.kind !== "ready") return refunds;
  if (capturedTotal(charges) !== BigInt(observation.expected.amount)) {
    return { issue: { kind: "capture_total_mismatch" }, kind: "conflict" };
  }
  return charges.length > 1
    ? { issue: { kind: "multiple_charges" }, kind: "conflict" }
    : { kind: "ready" };
};

/** A checkout that took money: it must name the money it took, and the reading
 *  must hold together, before what became of any refund can matter. */
const paidOutcome = (observation: PaymentObservation): ObservationOutcome => {
  const charges = observation.charges;
  if (charges === undefined) return moneyNobodyAskedFor;
  return readingProblemOrNull(observation) ?? paidSettled(observation, charges);
};

/** A checkout that asked for nothing. Money against it is the one diagnosis
 *  and is answered FIRST: a charge on a free checkout also mismatches every
 *  expected-vs-observed amount, and naming it a total mismatch would hide the
 *  money nobody asked for behind an arithmetic complaint. */
const freeOutcome = (observation: PaymentObservation): ObservationOutcome =>
  observation.charges !== undefined
    ? moneyNobodyAskedFor
    : (readingProblemOrNull(observation) ??
      (observation.expected.amount === 0
        ? { kind: "ready" }
        : moneyNobodyAskedFor));

/**
 * What the money on these charges comes to on its own, with no agreed total
 * behind it.
 *
 * A reference the site holds no signed price for — an old row, or one an
 * operator typed in — can still be judged on what the provider says it took and
 * gave back. It cannot be judged on what was owed, because nobody recorded
 * that, so the kinds that compare owed against observed are not asked here
 * rather than being asked against a stand-in total. The comparison that matters
 * before sending money back needs no agreed total anyway: money returned is
 * measured against money TAKEN, both of which the provider states.
 */
export const refundOutcomeOf = (
  charges: readonly ChargeMoney[],
): ObservationOutcome =>
  refundOverspendsCapture(charges)
    ? { issue: { kind: "refund_exceeds_capture" }, kind: "conflict" }
    : refundOutcome(charges);

/** What this reading amounts to. A checkout that owed nothing takes the free
 *  arm whatever the provider calls it: a provider that took money on one
 *  reports the session as paid, and routing by that word would name the money
 *  a total mismatch instead of money nobody asked for. */
export const outcomeOf = (observation: SettledReading): ObservationOutcome =>
  observation.expected.amount === 0 ||
  observation.status === "no_payment_required"
    ? freeOutcome(observation)
    : paidOutcome(observation);

/** Whether this reading has finished saying what happened to the money. A
 *  stored answer about one that has not is asking about nothing yet. */
export const hasSettled = (
  observation: PaymentObservation,
): observation is SettledReading =>
  observation.status === "paid" || observation.status === "no_payment_required";
