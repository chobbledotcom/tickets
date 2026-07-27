import { resolvePaymentCases } from "#shared/db/payments/case-resolution-batch.ts";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import {
  applyChargeRefund,
  getPaymentCharges,
  requestChargeRefund,
} from "#shared/db/payments/charges.ts";
import {
  applyPaymentSessionClaimKeepingLease,
  claimPaymentSession,
  type PaymentSessionClaim,
  releasePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { completeRefundDecisionsForPayment } from "#shared/db/payments/decision-completion.ts";
import type {
  PaymentCaseResource,
  PaymentCharge,
  PaymentSession,
  PaymentSessionProgress,
  StoredPaymentCharge,
} from "#shared/db/payments/types.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import type { PaymentRefundTarget } from "#shared/payment-runtime/refund-targets.ts";
import type { RefundResolution } from "#shared/payment-state/resources.ts";
import { getPaymentProvider } from "#shared/payments.ts";

const REFUND_LEASE_MS = 5 * 60 * 1_000;

export type PaymentRefundOutcome = {
  payment: PaymentSession;
  resolutions: RefundResolution[];
  status: "completed" | "failed" | "partial" | "pending";
};

export const currentPaymentChargesOrNull = (
  charges: readonly StoredPaymentCharge[],
): PaymentCharge[] | null => {
  const isCurrent = (charge: StoredPaymentCharge): charge is PaymentCharge =>
    "captured" in charge;
  return charges.every(isCurrent) ? [...charges] : null;
};

export const hasRemainingPaymentMoney = (
  charges: readonly PaymentCharge[],
): boolean =>
  charges.some((charge) => charge.refunded.amount < charge.captured.amount);

export const currentPaymentCharges = (
  payment: PaymentSession,
  charges: readonly StoredPaymentCharge[],
): PaymentCharge[] => {
  const current = currentPaymentChargesOrNull(charges);
  if (current === null) {
    throw new Error(`Payment ${payment.id} contains a legacy charge`);
  }
  return current;
};

const refundProgress = (
  payment: PaymentSession,
  state: PaymentSessionProgress["state"],
): PaymentSessionProgress =>
  paymentProgress(payment, {
    nextReconcileAt: state === "refunding" ? Date.now() + 60_000 : null,
    state,
  });

const overallRefundStatus = (
  resolutions: readonly RefundResolution[],
): PaymentRefundOutcome["status"] => {
  if (resolutions.some((resolution) => resolution.status === "failed")) {
    return "failed";
  }
  if (resolutions.some((resolution) => resolution.status === "partial")) {
    return "partial";
  }
  if (resolutions.some((resolution) => resolution.status === "pending")) {
    return "pending";
  }
  return "completed";
};

const recordRefundProblem = (
  payment: PaymentSession,
  charge: PaymentCharge,
  resolution: RefundResolution,
): ReturnType<typeof recordPaymentCase> =>
  recordPaymentCase({
    evidence: payment.bookingIntent,
    nextReconcileAt:
      resolution.status === "partial" ? null : Date.now() + 60_000,
    paymentId: payment.id,
    reason:
      resolution.status === "partial"
        ? "partial_refund"
        : resolution.status === "pending"
          ? "refund_pending"
          : "failed_refund",
    resource: resolution.refund ?? charge.providerReference,
    state: resolution.status === "partial" ? "needs_action" : "retrying",
  });

const chargeIsFullyRefunded = (charge: PaymentCharge): boolean =>
  charge.refunded.amount === charge.captured.amount;

const completedChargeResolution = (
  charge: PaymentCharge,
): RefundResolution => ({
  amount: charge.refunded,
  status: "completed",
});

type ChargeRefundResult = {
  resolution: RefundResolution;
  resolvedCaseResources: PaymentCaseResource[];
  retryStopped: boolean;
};

const completedChargeResult = (charge: PaymentCharge): ChargeRefundResult => ({
  resolution: completedChargeResolution(charge),
  resolvedCaseResources: [charge.providerReference],
  retryStopped: false,
});

const refundNeedsCase = (
  charge: PaymentCharge,
  resolution: RefundResolution,
): boolean =>
  resolution.status === "failed" ||
  resolution.status === "partial" ||
  (resolution.status === "pending" &&
    resolution.refund === undefined &&
    charge.providerReference.provider === "sumup");

const resolvedCaseResources = (
  charge: PaymentCharge,
  resolution: RefundResolution,
): PaymentCaseResource[] => [
  charge.providerReference,
  ...(charge.pendingRefund === null ? [] : [charge.pendingRefund]),
  ...(resolution.refund === undefined ? [] : [resolution.refund]),
];

const refundCharge = async (
  payment: PaymentSession,
  charge: PaymentCharge,
): Promise<ChargeRefundResult> => {
  if (chargeIsFullyRefunded(charge)) return completedChargeResult(charge);
  const account = await resolvePaymentAccount(
    charge.providerReference.provider,
  );
  if (account.accountId !== payment.accountId) {
    const resolution: RefundResolution = {
      amount: charge.refunded,
      reason: "provider_failed",
      status: "failed",
    };
    return recordProblemChargeResult(payment, charge, resolution);
  }
  const request = await requestChargeRefund(charge.id);
  const provider = await getPaymentProvider(charge.providerReference.provider);
  const resolution = await provider.refundCharge(
    charge,
    request.idempotencyKey,
  );
  const confirmed =
    resolution.status === "completed" || resolution.status === "partial"
      ? resolution.amount
      : charge.refunded;
  await applyChargeRefund(
    charge.id,
    request.idempotencyKey,
    confirmed,
    resolution,
    Date.now(),
  );
  if (refundNeedsCase(charge, resolution)) {
    return recordProblemChargeResult(payment, charge, resolution);
  }
  return {
    resolution,
    resolvedCaseResources:
      resolution.status === "completed"
        ? resolvedCaseResources(charge, resolution)
        : [],
    retryStopped: false,
  };
};

const recordProblemChargeResult = async (
  payment: PaymentSession,
  charge: PaymentCharge,
  resolution: RefundResolution,
): Promise<ChargeRefundResult> => {
  const update = await recordRefundProblem(payment, charge, resolution);
  return {
    resolution,
    resolvedCaseResources: [],
    retryStopped: update.paymentCase.state === "needs_action",
  };
};

const requireRefundClaim = async (
  payment: PaymentSession,
  claim: PaymentSessionClaim | undefined,
): Promise<PaymentSessionClaim> => {
  if (claim !== undefined) return claim;
  const acquired = await claimPaymentSession(payment.id, REFUND_LEASE_MS);
  if (acquired === null) {
    throw new Error(`Could not claim payment session ${payment.id} for refund`);
  }
  return acquired;
};

export type RetainedPaymentRefundAttempt =
  | ({ ok: true; claim: PaymentSessionClaim } & PaymentRefundOutcome)
  | {
      error: unknown;
      ok: false;
      claim: PaymentSessionClaim;
      payment: PaymentSession;
    };

const runClaimedRefund = async (
  payment: PaymentSession,
  charges: PaymentCharge[],
  claim: PaymentSessionClaim,
): Promise<RetainedPaymentRefundAttempt> => {
  const refunding = await applyPaymentSessionClaimKeepingLease(
    claim,
    refundProgress(payment, "refunding"),
  );
  try {
    const resolutions: RefundResolution[] = [];
    const resolvedResources: PaymentCaseResource[] = [];
    let retryStopped = false;
    for (const charge of charges) {
      const result = await refundCharge(refunding.payment, charge);
      resolutions.push(result.resolution);
      resolvedResources.push(...result.resolvedCaseResources);
      retryStopped ||= result.retryStopped;
    }
    await resolvePaymentCases(
      resolvedResources.map((resource) => ({
        paymentId: payment.id,
        resource,
      })),
    );
    const status = overallRefundStatus(resolutions);
    const state =
      status === "completed"
        ? "fully_refunded"
        : status === "partial" || retryStopped
          ? "needs_action"
          : "refunding";
    const retained = await applyPaymentSessionClaimKeepingLease(
      refunding.claim,
      refundProgress(refunding.payment, state),
    );
    if (status === "completed") {
      await completeRefundDecisionsForPayment(payment.id);
    }
    return {
      claim: retained.claim,
      ok: true,
      payment: retained.payment,
      resolutions,
      status,
    };
  } catch (error) {
    return {
      claim: refunding.claim,
      error,
      ok: false,
      payment: refunding.payment,
    };
  }
};

const prepareRefund = async (
  payment: PaymentSession,
  chargeValues?: readonly PaymentCharge[],
): Promise<{
  charges: PaymentCharge[];
  completed: PaymentRefundOutcome | null;
}> => {
  const stored = chargeValues ?? (await getPaymentCharges(payment.id));
  const charges = currentPaymentCharges(payment, stored);
  if (charges.length === 0) {
    throw new Error(`Payment ${payment.id} has no refundable charges`);
  }
  return { charges, completed: refundAlreadyCompleted(payment, charges) };
};

const refundAlreadyCompleted = (
  payment: PaymentSession,
  charges: PaymentCharge[],
): PaymentRefundOutcome | null =>
  payment.state === "fully_refunded" && charges.every(chargeIsFullyRefunded)
    ? {
        payment,
        resolutions: charges.map(completedChargeResolution),
        status: "completed",
      }
    : null;

const retainedCompletedRefund = (
  completed: PaymentRefundOutcome,
  claim: PaymentSessionClaim,
): RetainedPaymentRefundAttempt => ({ ...completed, claim, ok: true });

/** Refund one or many stored charges through one persisted, retry-safe path. */
export const refundCharges = async (
  payment: PaymentSession,
  chargeValues?: readonly PaymentCharge[],
  existingClaim?: PaymentSessionClaim,
): Promise<PaymentRefundOutcome> => {
  const { charges, completed } = await prepareRefund(payment, chargeValues);
  if (completed !== null) return completed;
  const claim = await requireRefundClaim(payment, existingClaim);
  const attempt = await runClaimedRefund(payment, charges, claim);
  if (!attempt.ok) {
    await releasePaymentSessionClaim(attempt.claim, Date.now());
    throw attempt.error;
  }
  const released = await releasePaymentSessionClaim(
    attempt.claim,
    attempt.payment.nextReconcileAt,
  );
  return {
    payment: released,
    resolutions: attempt.resolutions,
    status: attempt.status,
  };
};

export const refundPaymentTargets = async (
  targets: readonly PaymentRefundTarget[],
): Promise<PaymentRefundOutcome[]> => {
  const outcomes: PaymentRefundOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await refundCharges(target.payment, target.charges));
  }
  return outcomes;
};

/** Refund while retaining the aggregate claim so placeholder completion can
 * persist the provider effect before releasing or advancing to local effects. */
export const refundChargesKeepingClaim = async (
  payment: PaymentSession,
  claim: PaymentSessionClaim,
  chargeValues?: readonly PaymentCharge[],
): Promise<RetainedPaymentRefundAttempt> => {
  const { charges, completed } = await prepareRefund(payment, chargeValues);
  return completed === null
    ? runClaimedRefund(payment, charges, claim)
    : retainedCompletedRefund(completed, claim);
};
