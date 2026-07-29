import type { PaymentConflict } from "#shared/payment-state/conflict.ts";
import type { ObservationOutcome } from "#shared/payment-state/diagnose.ts";
import { outcomeOf } from "#shared/payment-state/diagnose.ts";
import type { PaymentResolution } from "#shared/payment-state/lifecycle.ts";
import type {
  PaymentObservation,
  ProviderRead,
} from "#shared/payment-state/observation.ts";

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

/** Turn what a reading amounts to into the answer for that payment. Reading a
 *  checkout that has not finished cannot happen here — the caller has already
 *  sent those down the waiting path. */
const resolutionFor = (
  observation: PaymentObservation,
  outcome: ObservationOutcome,
): PaidPaymentResolution => {
  switch (outcome.kind) {
    case "conflict":
      return paymentConflict(observation, outcome.issue);
    case "fully_refunded":
      return { observation, status: "fully_refunded" };
    case "refund_pending":
      return pendingPayment(observation, "refund_pending");
    case "ready":
      return { observation, status: "ready" };
    case "still_going":
      throw new Error(
        `A reading that has not finished cannot be settled: ${observation.session.id}`,
      );
  }
};

export const resolvePaidPayment = (
  observation: PaymentObservation & { status: "paid" },
): PaidPaymentResolution => resolutionFor(observation, outcomeOf(observation));

const resolveNoPaymentRequired = (
  observation: PaymentObservation & { status: "no_payment_required" },
): PaidPaymentResolution => resolutionFor(observation, outcomeOf(observation));

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
