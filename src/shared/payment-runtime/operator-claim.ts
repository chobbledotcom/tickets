import type { PaymentOperatorCase } from "#shared/payment-runtime/operator-context.ts";
import {
  paymentDecisionSelections,
  requireLegacyOperatorPayment,
} from "#shared/payment-runtime/operator-context.ts";
import { currentPaymentChargesOrNull } from "#shared/payment-runtime/refund.ts";
import type {
  PaymentChargeDecisionSnapshot,
  PaymentDecisionSnapshot,
  PaymentLegacyDecisionSnapshot,
  PaymentOperatorDecision,
  PaymentOperatorDecisionClaim,
  PaymentOperatorSelection,
} from "#shared/payment-state/lifecycle.ts";

export type PreparedPaymentDecision = {
  claim: PaymentOperatorDecisionClaim;
  decision: PaymentOperatorDecision;
};

const reviewedCharges = (context: PaymentOperatorCase) => {
  const charges = currentPaymentChargesOrNull(context.charges);
  if (charges === null || charges.length === 0) {
    throw new Error(
      `Payment ${context.case.paymentId} has no reviewed charges`,
    );
  }
  return charges.map((charge) => ({
    captured: charge.captured,
    chargeId: charge.id,
    providerReference: charge.providerReference,
    refunded: charge.refunded,
  }));
};

const chargeSnapshot = (
  context: PaymentOperatorCase,
): PaymentChargeDecisionSnapshot => {
  if (context.payment.origin === "current") {
    return {
      accountId: context.payment.value.accountId,
      charges: reviewedCharges(context),
      kind: "charges",
      mode: context.payment.value.mode,
      paymentId: context.payment.value.id,
      provider: context.payment.value.provider,
    };
  }
  const payment = context.payment.value;
  if (
    payment.accountId === null ||
    payment.mode === null ||
    payment.provider === null
  ) {
    throw new Error(`Legacy payment ${payment.id} has no assigned account`);
  }
  return {
    accountId: payment.accountId,
    charges: reviewedCharges(context),
    kind: "charges",
    mode: payment.mode,
    paymentId: payment.id,
    provider: payment.provider,
  };
};

const legacyAssignmentSnapshot = (
  context: PaymentOperatorCase,
): PaymentLegacyDecisionSnapshot => {
  requireLegacyOperatorPayment(context);
  const charges = context.charges.flatMap((charge) =>
    "captured" in charge
      ? []
      : [{ chargeId: charge.id, providerReference: charge.providerReference }],
  );
  if (charges.length === 0) {
    throw new Error(
      `Legacy payment ${context.case.paymentId} has no reference`,
    );
  }
  return {
    charges,
    kind: "legacy_assignment",
    paymentId: context.case.paymentId,
  };
};

const decisionSnapshot = (
  context: PaymentOperatorCase,
  selection: PaymentOperatorSelection,
): PaymentDecisionSnapshot =>
  selection.kind === "assign_provider" ||
  selection.kind === "keep_legacy_payment"
    ? legacyAssignmentSnapshot(context)
    : chargeSnapshot(context);

const requireOfferedSelection = (
  context: PaymentOperatorCase,
  selection: PaymentOperatorSelection,
): void => {
  const accounts = selection.kind === "assign_provider" ? [selection] : [];
  if (
    !paymentDecisionSelections(context, accounts).some(
      (candidate) =>
        candidate.kind === selection.kind &&
        (candidate.kind !== "assign_provider" ||
          (selection.kind === "assign_provider" &&
            candidate.provider === selection.provider &&
            candidate.mode === selection.mode &&
            candidate.accountId === selection.accountId)),
    )
  ) {
    throw new Error(
      "This decision is not available for the current payment facts",
    );
  }
};

const decisionBase = (
  claim: PaymentOperatorDecisionClaim,
): Pick<
  PaymentOperatorDecision,
  "actorId" | "caseRevision" | "decidedAt" | "reason"
> => ({
  actorId: claim.actorId,
  caseRevision: claim.caseRevision,
  decidedAt: claim.claimedAt,
  reason: claim.reason,
});

const exactDecision = (
  claim: PaymentOperatorDecisionClaim,
): PaymentOperatorDecision => {
  const base = decisionBase(claim);
  const selection = claim.selection;
  switch (selection.kind) {
    case "complete_booking":
    case "refund_remaining":
      return { ...base, kind: selection.kind };
    case "confirm_fully_refunded": {
      if (claim.reviewed.kind !== "charges") {
        throw new Error("A charge decision lost its reviewed facts");
      }
      return {
        ...base,
        charges: claim.reviewed.charges.map(({ captured, chargeId }) => ({
          captured,
          chargeId,
        })),
        kind: selection.kind,
      };
    }
    case "keep_legacy_payment":
      return { ...base, kind: selection.kind };
    case "assign_provider":
      return { ...base, ...selection, kind: selection.kind, read: null };
  }
};

export const preparePaymentDecision = (
  context: PaymentOperatorCase,
  actorId: number,
  caseRevision: number,
  reason: string,
  selection: PaymentOperatorSelection,
  claimedAt = Date.now(),
): PreparedPaymentDecision => {
  requireOfferedSelection(context, selection);
  const claim: PaymentOperatorDecisionClaim = {
    actorId,
    caseRevision,
    claimedAt,
    reason: reason.trim(),
    reviewed: decisionSnapshot(context, selection),
    selection,
  };
  return { claim, decision: exactDecision(claim) };
};
