import type {
  PaymentConflict,
  PaymentResolution,
} from "#shared/payment-state/lifecycle.ts";
import type {
  PaymentObservation,
  ProviderRead,
} from "#shared/payment-state/observation.ts";
import { resolveRefund } from "#shared/payment-state/refund.ts";
import type { ChargeLegs } from "#shared/payment-state/resources.ts";
import {
  providerRefundResources,
  refundMoneyMatchesCapture,
} from "#shared/payment-state/resources.ts";

export type PaymentObservationCheck =
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

export const validatePaymentObservation = (
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

  const refunds = providerRefundResources(charges);
  if (firstDuplicate(refunds.map((refund) => refund.id)) !== undefined) {
    return conflict({ kind: "duplicate_refund" });
  }
  const pendingCount = charges
    .flatMap((charge) => charge.refunds)
    .filter((refund) => refund.status === "pending").length;
  if (pendingCount > 1) {
    return conflict({ kind: "multiple_pending_refunds" });
  }

  const captured = moneyTotal(charges);
  const expected = BigInt(observation.expected.amount);
  if (captured < expected) return conflict({ kind: "partial_charge" });
  if (captured !== expected) {
    return conflict({ kind: "capture_total_mismatch" });
  }
  return { valid: true };
};

type UnresolvedRead = Extract<ProviderRead, { status: "invalid" | "missing" }>;

const unresolvedReadResolution = (
  read: UnresolvedRead,
  unprovenReason: "unproven_invalid_data" | "unproven_missing_resource",
  issue: PaymentConflict,
): PaymentResolution =>
  read.ownership === undefined
    ? { reason: unprovenReason, resource: read.requested, status: "ignore" }
    : { issue, resource: read.requested, status: "conflict" };

const invalidReadResolution = (
  read: Extract<ProviderRead, { status: "invalid" }>,
): PaymentResolution =>
  unresolvedReadResolution(read, "unproven_invalid_data", {
    kind: "invalid_provider_data",
    reason: read.reason,
  });

const missingReadResolution = (
  read: Extract<ProviderRead, { status: "missing" }>,
): PaymentResolution =>
  unresolvedReadResolution(read, "unproven_missing_resource", {
    kind: "missing_resource",
  });

export type PaidPaymentResolution = Extract<
  PaymentResolution,
  { status: "conflict" | "fully_refunded" | "pending" | "ready" }
>;

type PendingPaymentResolution = Extract<
  PaidPaymentResolution,
  { status: "pending" }
>;

export const pendingPayment = (
  observation: PaymentObservation,
  reason: PendingPaymentResolution["reason"],
): PendingPaymentResolution => ({ observation, reason, status: "pending" });

const paymentConflict = (
  observation: PaymentObservation,
  issue: PaymentConflict,
): PaidPaymentResolution => ({
  issue,
  observation,
  resource: observation.session,
  status: "conflict",
});

export const resolvePaidPayment = (
  observation: PaymentObservation & { status: "paid" },
): PaidPaymentResolution => {
  if (observation.charges === undefined) {
    return paymentConflict(observation, { kind: "paid_without_charge" });
  }
  const checked = validatePaymentObservation(observation);
  if (!checked.valid) {
    return paymentConflict(observation, checked.issue);
  }

  const refunds = observation.charges.map(resolveRefund);
  if (refunds.some((refund) => refund.status === "completed")) {
    return { observation, status: "fully_refunded" };
  }
  if (refunds.some((refund) => refund.status === "pending")) {
    return pendingPayment(observation, "refund_pending");
  }
  if (
    refunds.some(
      (refund) =>
        refund.status === "failed" && refund.reason === "provider_failed",
    )
  ) {
    return {
      issue: { kind: "failed_refund" },
      observation,
      resource: observation.session,
      status: "conflict",
    };
  }
  if (refunds.some((refund) => refund.status === "partial")) {
    return {
      issue: { kind: "partial_refund" },
      observation,
      resource: observation.session,
      status: "conflict",
    };
  }
  return { observation, status: "ready" };
};

const resolveNoPaymentRequired = (
  observation: PaymentObservation & { status: "no_payment_required" },
): PaidPaymentResolution => {
  const checked = validatePaymentObservation(observation);
  if (!checked.valid) return paymentConflict(observation, checked.issue);
  // The check above already refused any reading whose provider total differs
  // from what was asked for, so nothing asked for means nothing taken.
  return observation.expected.amount === 0 && observation.charges === undefined
    ? { observation, status: "ready" }
    : paymentConflict(observation, { kind: "paid_without_charge" });
};

const foundReadResolution = (
  read: Extract<ProviderRead, { status: "found" }>,
): PaymentResolution => {
  if (read.observation.status === "pending") {
    return pendingPayment(read.observation, "payment_pending");
  }
  if (read.observation.status === "failed") {
    return {
      reason: "payment_failed",
      resource: read.returned,
      status: "ignore",
    };
  }
  if (read.observation.status === "no_payment_required") {
    return resolveNoPaymentRequired({
      ...read.observation,
      status: "no_payment_required",
    });
  }
  return resolvePaidPayment({ ...read.observation, status: "paid" });
};

export const resolvePayment = (read: ProviderRead): PaymentResolution => {
  switch (read.status) {
    case "found":
      return foundReadResolution(read);
    case "missing":
      return missingReadResolution(read);
    case "unavailable":
      return read.ownership === undefined
        ? { reason: "not_ours", resource: read.requested, status: "ignore" }
        : {
            reason: read.reason,
            resource: read.requested,
            status: "retry",
          };
    case "invalid":
      return invalidReadResolution(read);
  }
};
