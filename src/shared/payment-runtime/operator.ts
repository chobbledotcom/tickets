/* jscpd:ignore-start -- imports */
import {
  confirmChargesFullyRefunded,
  upgradeLegacyPaymentCharge,
} from "#shared/db/payments/charges.ts";
import {
  beginPaymentDecisionAttempt,
  reviewPaymentDecisionAgain,
} from "#shared/db/payments/decision-attempts.ts";
import {
  completeLegacyAssignment,
  completePaymentDecisionAndResolveCase,
  completePaymentDecisionWithNextCase,
} from "#shared/db/payments/decision-completion.ts";
import {
  acceptPaymentDecision,
  getPaymentDecisionById,
  replaceRunningPaymentDecision,
  retryPaymentDecision,
} from "#shared/db/payments/decisions.ts";
import { assignLegacyPaymentAccount } from "#shared/db/payments/legacy-sessions.ts";
import type { PaymentCaseDecision } from "#shared/db/payments/types.ts";
import { errorMessage } from "#shared/error-message.ts";
import {
  PaymentAccountConfigurationError,
  requireStoredPaymentAccount,
} from "#shared/payment-runtime/account.ts";
import { preparePaymentDecision } from "#shared/payment-runtime/operator-claim.ts";
import {
  getPaymentOperatorCase,
  hasProvenBooking,
  type PaymentOperatorCase,
  requireLegacyOperatorPayment,
} from "#shared/payment-runtime/operator-context.ts";
import { readLegacyProviderReference } from "#shared/payment-runtime/operator-legacy-read.ts";
import {
  type FulfilPayment,
  fulfilProvenPayment,
} from "#shared/payment-runtime/process.ts";
import {
  currentPaymentCharges,
  currentPaymentChargesOrNull,
  refundCharges,
} from "#shared/payment-runtime/refund.ts";
import type {
  PaymentOperatorDecision,
  PaymentOperatorSelection,
} from "#shared/payment-state/lifecycle.ts";
import { sameJson } from "#shared/same-json.ts";

/* jscpd:ignore-end */

const RETRY_DELAY_MS = 60_000;

export type PaymentDecisionOutcome = {
  decisionId: number;
  status: "completed" | "needs_action" | "retrying" | "review_again";
};

export type PaymentDecisionInput = {
  actorId: number;
  caseId: number;
  caseRevision: number;
  reason: string;
  selection: PaymentOperatorSelection;
};

const requireCurrentPayment = (context: PaymentOperatorCase) => {
  if (context.payment.origin !== "current") {
    throw new Error(`Payment ${context.case.paymentId} is not current`);
  }
  return context.payment.value;
};

const completeBooking = async (
  context: PaymentOperatorCase,
  fulfil: FulfilPayment,
): Promise<"completed" | "retrying"> => {
  if (!hasProvenBooking(context)) {
    throw new Error("Stored payment evidence no longer proves this booking");
  }
  const outcome = await fulfilProvenPayment(
    context.payment.value,
    context.case.evidence.read,
    fulfil,
  );
  return outcome.status === "fulfilled" || outcome.status === "completed"
    ? "completed"
    : "retrying";
};

const refundRemaining = async (
  context: PaymentOperatorCase,
): Promise<"completed" | "retrying"> => {
  const payment = requireCurrentPayment(context);
  const outcome = await refundCharges(
    payment,
    currentPaymentCharges(payment, context.charges),
  );
  return outcome.status === "completed" ? "completed" : "retrying";
};

const confirmFullyRefunded = async (
  context: PaymentOperatorCase,
  decision: Extract<
    PaymentOperatorDecision,
    { kind: "confirm_fully_refunded" }
  >,
): Promise<"completed"> => {
  const payment = requireCurrentPayment(context);
  await confirmChargesFullyRefunded(payment.id, decision.charges);
  return "completed";
};

const upgradedChargeMatches = (
  context: PaymentOperatorCase,
  read: Extract<
    NonNullable<
      Extract<PaymentOperatorDecision, { kind: "assign_provider" }>["read"]
    >,
    { status: "attached" }
  >,
): boolean => {
  const charges = currentPaymentChargesOrNull(context.charges);
  return (
    charges?.length === 1 &&
    sameJson(charges[0]?.providerReference, read.charge) &&
    sameJson(charges[0]?.captured, read.captured) &&
    sameJson(charges[0]?.refunded, read.refunded)
  );
};

type DecisionRunStatus =
  | "completed"
  | "legacy_assigned"
  | "retrying"
  | { nextCaseReason: string };

type ProviderSelection = Extract<
  PaymentOperatorSelection,
  { kind: "assign_provider" }
>;
type ProviderDecision = Extract<
  PaymentOperatorDecision,
  { kind: "assign_provider" }
>;
type AttachedLegacyRead = Extract<
  NonNullable<ProviderDecision["read"]>,
  { status: "attached" }
>;

const requireProviderDecision = (
  running: PaymentCaseDecision,
): { saved: ProviderDecision; selection: ProviderSelection } => {
  const selection = running.claim.selection;
  const saved = running.decision;
  if (
    selection.kind !== "assign_provider" ||
    saved?.kind !== "assign_provider"
  ) {
    throw new Error(`Payment decision ${running.id} lost its account facts`);
  }
  return { saved, selection };
};

const accountStillMatches = async (
  running: PaymentCaseDecision,
  selection: ProviderSelection,
): Promise<boolean> => {
  try {
    await requireStoredPaymentAccount(selection);
    return true;
  } catch (error) {
    if (!(error instanceof PaymentAccountConfigurationError)) throw error;
    await reviewPaymentDecisionAgain(running);
    return false;
  }
};

const readLegacyAssignment = async (
  payment: Extract<
    PaymentOperatorCase["payment"],
    { origin: "legacy" }
  >["value"],
  running: PaymentCaseDecision,
  saved: ProviderDecision,
  selection: ProviderSelection,
): Promise<NonNullable<ProviderDecision["read"]>> => {
  const read =
    saved.read ?? (await readLegacyProviderReference(payment, selection));
  if (saved.read === null) {
    await replaceRunningPaymentDecision(running.id, { ...saved, read });
  }
  return read;
};

const upgradeAttachedLegacyCharge = async (
  context: PaymentOperatorCase,
  running: PaymentCaseDecision,
  read: AttachedLegacyRead,
): Promise<void> => {
  if (upgradedChargeMatches(context, read)) return;
  const snapshot = running.claim.reviewed;
  if (snapshot.kind !== "legacy_assignment") {
    throw new Error(`Payment decision ${running.id} lost its legacy charge`);
  }
  const legacyCharge = snapshot.charges[0];
  if (legacyCharge === undefined) {
    throw new Error(`Payment decision ${running.id} lost its legacy charge`);
  }
  await upgradeLegacyPaymentCharge(
    context.case.paymentId,
    read.session,
    {
      captured: read.captured,
      confirmedRefunded: read.refunded,
      refunds: [],
      resource: read.charge,
    },
    legacyCharge.chargeId,
  );
};

const assignProvider = async (
  context: PaymentOperatorCase,
  running: PaymentCaseDecision,
): Promise<DecisionRunStatus> => {
  const payment = requireLegacyOperatorPayment(context);
  const { saved, selection } = requireProviderDecision(running);
  if (!(await accountStillMatches(running, selection))) {
    return { nextCaseReason: "review_again" };
  }
  const read = await readLegacyAssignment(payment, running, saved, selection);
  if (read.status === "missing" || read.status === "ambiguous") {
    return {
      nextCaseReason:
        read.status === "missing"
          ? "legacy_provider_unknown"
          : "legacy_mapping_ambiguous",
    };
  }
  await assignLegacyPaymentAccount(context.case.paymentId, selection);
  if (read.status === "reviewed") {
    return { nextCaseReason: "legacy_mapping_ambiguous" };
  }
  await upgradeAttachedLegacyCharge(context, running, read);
  return "legacy_assigned";
};

const runClaimedDecision = async (
  context: PaymentOperatorCase,
  running: PaymentCaseDecision,
  fulfil: FulfilPayment,
): Promise<DecisionRunStatus> => {
  switch (running.claim.selection.kind) {
    case "complete_booking":
      return completeBooking(context, fulfil);
    case "refund_remaining":
      return refundRemaining(context);
    case "confirm_fully_refunded": {
      const decision = running.decision;
      if (decision?.kind !== "confirm_fully_refunded") {
        throw new Error(`Payment decision ${running.id} lost refund evidence`);
      }
      return confirmFullyRefunded(context, decision);
    }
    case "keep_legacy_payment":
      return "completed";
    case "assign_provider":
      return assignProvider(context, running);
  }
};

const finishDecision = async (
  context: PaymentOperatorCase,
  running: PaymentCaseDecision,
  status: DecisionRunStatus,
): Promise<PaymentDecisionOutcome> => {
  if (status === "retrying") {
    await retryPaymentDecision(
      running.id,
      "The payment work is still pending.",
      Date.now() + RETRY_DELAY_MS,
    );
    return { decisionId: running.id, status };
  }
  if (typeof status === "object") {
    if (status.nextCaseReason === "review_again") {
      return { decisionId: running.id, status: "review_again" };
    }
    await completePaymentDecisionWithNextCase(running, status.nextCaseReason);
    return { decisionId: running.id, status: "needs_action" };
  }
  if (status === "legacy_assigned") {
    await completeLegacyAssignment(running, context.case.paymentId);
  } else {
    await completePaymentDecisionAndResolveCase(running);
  }
  return { decisionId: running.id, status: "completed" };
};

const executeAcceptedDecision = async (
  accepted: PaymentCaseDecision,
  fulfil: FulfilPayment,
): Promise<PaymentDecisionOutcome> => {
  const attempt = await beginPaymentDecisionAttempt(
    accepted.id,
    Date.now(),
    accepted,
  );
  if (attempt.status === "review_again") {
    return { decisionId: accepted.id, status: "review_again" };
  }
  if (attempt.status === "completed") {
    return { decisionId: accepted.id, status: "completed" };
  }
  if (attempt.status === "busy") {
    return { decisionId: accepted.id, status: "retrying" };
  }
  if (attempt.status !== "running") {
    throw new Error(`Payment decision ${accepted.id} has an unknown state`);
  }
  const running = attempt.decision;
  try {
    const context = await getPaymentOperatorCase(running.paymentCaseId);
    if (context === null) {
      throw new Error(`Payment case ${running.paymentCaseId} vanished`);
    }
    return await finishDecision(
      context,
      running,
      await runClaimedDecision(context, running, fulfil),
    );
  } catch (error) {
    await retryPaymentDecision(
      running.id,
      "The saved payment decision could not finish.",
      Date.now() + RETRY_DELAY_MS,
    );
    throw new Error(
      `Payment decision ${running.id} failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
};

export const submitPaymentDecision = async (
  input: PaymentDecisionInput,
  fulfil: FulfilPayment,
): Promise<PaymentDecisionOutcome> => {
  const context = await getPaymentOperatorCase(input.caseId);
  if (context === null) {
    throw new Error(`Payment case ${input.caseId} was not found`);
  }
  const prepared = preparePaymentDecision(
    context,
    input.actorId,
    input.caseRevision,
    input.reason,
    input.selection,
  );
  const accepted = await acceptPaymentDecision(
    input.caseId,
    prepared.claim,
    prepared.decision,
  );
  return executeAcceptedDecision(accepted, fulfil);
};

export const resumePaymentDecision = async (
  decisionId: number,
  fulfil: FulfilPayment,
): Promise<PaymentDecisionOutcome> => {
  const decision = await getPaymentDecisionById(decisionId);
  return executeAcceptedDecision(decision, fulfil);
};
