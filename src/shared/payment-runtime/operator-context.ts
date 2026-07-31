import { getPaymentCaseByIdOrNull } from "#shared/db/payments/cases.ts";
import { getPaymentCharges } from "#shared/db/payments/charges.ts";
import { getPaymentCaseDecisions } from "#shared/db/payments/decisions.ts";
import {
  getLegacyPaymentsByIds,
  type LegacyPaymentReplay,
} from "#shared/db/payments/legacy-sessions.ts";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import type {
  PaymentCase,
  PaymentCaseDecision,
  PaymentCharge,
  PaymentSession,
  StoredPaymentCharge,
} from "#shared/db/payments/types.ts";
import type { PaymentAccount } from "#shared/payment-runtime/account.ts";
import {
  currentPaymentChargesOrNull,
  hasRemainingPaymentMoney,
} from "#shared/payment-runtime/refund.ts";
import type { PaymentOperatorSelection } from "#shared/payment-state/lifecycle.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import { sameJson } from "#shared/same-json.ts";

export type OperatorPayment =
  | { origin: "current"; value: PaymentSession }
  | { origin: "legacy"; value: LegacyPaymentReplay };

export interface PaymentOperatorCase {
  case: PaymentCase;
  charges: StoredPaymentCharge[];
  decisions: PaymentCaseDecision[];
  payment: OperatorPayment;
}

export const requireLegacyOperatorPayment = (
  context: PaymentOperatorCase,
): LegacyPaymentReplay => {
  if (context.payment.origin !== "legacy") {
    throw new Error(`Payment ${context.case.paymentId} is not legacy`);
  }
  return context.payment.value;
};

interface ProvenPaymentOperatorCase extends PaymentOperatorCase {
  case: PaymentCase & {
    evidence: {
      kind: "provider_read";
      read: Extract<ProviderRead, { status: "found" }>;
    };
  };
  payment: { origin: "current"; value: PaymentSession };
}

export const getPaymentOperatorCase = async (
  caseId: number,
): Promise<PaymentOperatorCase | null> => {
  const paymentCase = await getPaymentCaseByIdOrNull(caseId);
  if (paymentCase === null) return null;
  const [[current], legacy, charges, decisions] = await Promise.all([
    getPaymentSessions([paymentCase.paymentId]),
    getLegacyPaymentsByIds([paymentCase.paymentId]),
    getPaymentCharges(paymentCase.paymentId),
    getPaymentCaseDecisions(caseId),
  ]);
  const payment: OperatorPayment =
    current === null || current === undefined
      ? { origin: "legacy", value: requireLegacyPayment(legacy, paymentCase) }
      : { origin: "current", value: current };
  return { case: paymentCase, charges, decisions, payment };
};

const requireLegacyPayment = (
  payments: LegacyPaymentReplay[],
  paymentCase: PaymentCase,
): LegacyPaymentReplay => {
  const payment = payments[0];
  if (payment === undefined) {
    throw new Error(`Payment case ${paymentCase.id} has no payment`);
  }
  return payment;
};

const isRefundCase = (reason: string): boolean =>
  reason === "partial_refund" ||
  reason === "failed_refund" ||
  reason === "legacy_refund_amount_unknown";

const paymentProof = (
  captured: PaymentCharge["captured"],
  refunded: PaymentCharge["refunded"],
  resource: PaymentCharge["providerReference"],
) => ({ captured, refunded, resource });

const hasCurrentCharges = (
  charges: PaymentCharge[] | null,
): charges is PaymentCharge[] => charges !== null && charges.length > 0;

const hasUsableLegacyReference = (payment: LegacyPaymentReplay): boolean => {
  const processed = payment.runtime.processedPayment?.paymentReference;
  const attendee = payment.runtime.attendeePayment?.paymentReference;
  return (
    (processed !== undefined && processed !== "") ||
    (attendee !== undefined && attendee !== "")
  );
};

export const hasActivePaymentDecision = (
  context: PaymentOperatorCase,
): boolean =>
  context.decisions.some((decision) => decision.state !== "completed");

const triedLegacyProviders = (
  context: PaymentOperatorCase,
): Set<PaymentAccount["provider"]> =>
  new Set(
    context.decisions.flatMap((decision) =>
      decision.claim.selection.kind === "assign_provider"
        ? [decision.claim.selection.provider]
        : [],
    ),
  );

const hasReviewedLegacyFacts = (context: PaymentOperatorCase): boolean =>
  context.decisions.some(
    (decision) =>
      decision.decision?.kind === "assign_provider" &&
      decision.decision.read?.status === "reviewed",
  );

const currentPaymentSelections = (
  context: PaymentOperatorCase,
  charges: PaymentCharge[] | null,
): PaymentOperatorSelection[] => [
  ...(hasProvenBooking(context) ? [{ kind: "complete_booking" as const }] : []),
  ...(hasCurrentCharges(charges) && hasRemainingPaymentMoney(charges)
    ? [{ kind: "refund_remaining" as const }]
    : []),
  ...(hasCurrentCharges(charges) && isRefundCase(context.case.reason)
    ? [{ kind: "confirm_fully_refunded" as const }]
    : []),
];

const legacyAssignmentSelections = (
  context: PaymentOperatorCase,
  payment: LegacyPaymentReplay,
  accounts: readonly PaymentAccount[],
): PaymentOperatorSelection[] => {
  if (
    !context.charges.some((charge) => !("captured" in charge)) ||
    !hasUsableLegacyReference(payment)
  )
    return [];
  const tried = triedLegacyProviders(context);
  return accounts
    .filter(
      ({ provider }) => payment.provider !== provider && !tried.has(provider),
    )
    .map(({ accountId, mode, provider }) => ({
      accountId,
      kind: "assign_provider" as const,
      mode,
      provider,
    }));
};

const legacyPaymentSelections = (
  context: PaymentOperatorCase,
  payment: LegacyPaymentReplay,
  charges: PaymentCharge[] | null,
  accounts: readonly PaymentAccount[],
): PaymentOperatorSelection[] =>
  hasCurrentCharges(charges) || hasReviewedLegacyFacts(context)
    ? [{ kind: "keep_legacy_payment" }]
    : legacyAssignmentSelections(context, payment, accounts);

/** Stored found evidence proves all booking money even when one policy needs approval. */
export const hasProvenBooking = (
  context: PaymentOperatorCase,
): context is ProvenPaymentOperatorCase => {
  if (context.payment.origin !== "current") return false;
  const evidence = context.case.evidence;
  if (!("kind" in evidence) || evidence.kind !== "provider_read") return false;
  const read = evidence.read;
  if (read.status !== "found" || read.observation.status !== "paid")
    return false;
  const charges = currentPaymentChargesOrNull(context.charges);
  const observed = read.observation.charges;
  if (charges === null || charges.length === 0 || observed === undefined) {
    return false;
  }
  const payment = context.payment.value;
  const captured = charges.reduce(
    (total, charge) => total + charge.captured.amount,
    0,
  );
  return (
    read.observation.ownership.localPaymentId === payment.id &&
    read.observation.accountId === payment.accountId &&
    read.observation.mode === payment.mode &&
    sameJson(read.observation.bookingIntent, payment.bookingIntent) &&
    sameJson(read.observation.expected, payment.expected) &&
    read.observation.providerTotal.currency === payment.expected.currency &&
    read.observation.providerTotal.amount === payment.expected.amount &&
    captured === payment.expected.amount &&
    charges.every(
      (charge) =>
        charge.captured.currency === payment.expected.currency &&
        charge.refunded.amount === 0 &&
        charge.pendingRefund === null,
    ) &&
    sameJson(
      observed.map((charge) =>
        paymentProof(
          charge.captured,
          charge.confirmedRefunded,
          charge.resource,
        ),
      ),
      charges.map((charge) =>
        paymentProof(
          charge.captured,
          charge.refunded,
          charge.providerReference,
        ),
      ),
    )
  );
};

export const paymentDecisionSelections = (
  context: PaymentOperatorCase,
  accounts: readonly PaymentAccount[],
): PaymentOperatorSelection[] => {
  if (
    context.case.state !== "needs_action" ||
    hasActivePaymentDecision(context)
  )
    return [];
  const charges = currentPaymentChargesOrNull(context.charges);
  return context.payment.origin === "legacy"
    ? legacyPaymentSelections(context, context.payment.value, charges, accounts)
    : currentPaymentSelections(context, charges);
};
