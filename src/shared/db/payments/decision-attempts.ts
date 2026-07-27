/* jscpd:ignore-start -- imports */
import {
  queryAll,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  claimPaymentDecisionAttempt,
  PAYMENT_DECISION_LEASE_MS,
  paymentDecisionChargeIndexes,
} from "#shared/db/payments/decision-claim.ts";
import { getPaymentDecisionById } from "#shared/db/payments/decisions.ts";
import type {
  PaymentCaseDecision,
  PaymentCharge,
} from "#shared/db/payments/types.ts";
import type {
  PaymentChargeDecisionSnapshot,
  PaymentLegacyDecisionSnapshot,
} from "#shared/payment-state/lifecycle.ts";
/* jscpd:ignore-end */

export const PAYMENT_DECISION_PAGE_SIZE = 1;

type DecisionStateRow = {
  attempt_count: number;
  last_attempt_at: number | null;
  next_retry_at: number | null;
  state: PaymentCaseDecision["state"];
};

type CaseStateRow = { revision: number; state: string };

type PaymentStateRow = {
  account_id: string | null;
  mode: string | null;
  origin: string;
  provider: string | null;
};

type ChargeStateRow = {
  captured_amount: number | null;
  currency: string | null;
  id: number;
  origin: string;
  provider_reference: string;
  reference_index: string | null;
  refunded_amount: number | null;
};

export type PaymentDecisionAttempt =
  | { decision: PaymentCaseDecision; status: "running" }
  | { status: "busy" | "completed" | "review_again" };

export type DuePaymentDecision = { caseId: number; id: number };

const loadPaymentState = async (
  tx: TxScope,
  paymentId: string,
): Promise<PaymentStateRow | undefined> => {
  const result = await tx.execute({
    args: [paymentId],
    sql: `SELECT origin, provider, mode, account_id
            FROM payment_sessions WHERE id = ?`,
  });
  return resultRows<PaymentStateRow>(result)[0];
};

const loadChargeStates = async (
  tx: TxScope,
  paymentId: string,
): Promise<ChargeStateRow[]> =>
  resultRows<ChargeStateRow>(
    await tx.execute({
      args: [paymentId],
      sql: `SELECT id, origin, provider_reference, reference_index,
                   captured_amount, currency, refunded_amount
              FROM payment_charges WHERE payment_id = ? ORDER BY id`,
    }),
  );

const loadCaseState = async (
  tx: TxScope,
  caseId: number,
): Promise<CaseStateRow | undefined> =>
  resultRows<CaseStateRow>(
    await tx.execute({
      args: [caseId],
      sql: "SELECT revision, state FROM payment_cases WHERE id = ?",
    }),
  )[0];

const isDue = (row: DecisionStateRow, attemptedAt: number): boolean =>
  row.state === "accepted" ||
  (row.state === "retrying" &&
    row.next_retry_at !== null &&
    row.next_retry_at <= attemptedAt) ||
  (row.state === "running" &&
    row.last_attempt_at !== null &&
    row.last_attempt_at <= attemptedAt - PAYMENT_DECISION_LEASE_MS);

const moneyMatches = (
  amount: number | null,
  currency: string | null,
  expected: PaymentCharge["captured"],
): boolean => amount === expected.amount && currency === expected.currency;

const allChargesMatch = <Expected>(
  charges: ChargeStateRow[],
  expectedCharges: Expected[],
  matches: (
    charge: ChargeStateRow,
    expected: Expected,
    index: number,
  ) => boolean,
): boolean =>
  charges.length === expectedCharges.length &&
  expectedCharges.every((expected, index) => {
    const charge = charges[index];
    return charge !== undefined && matches(charge, expected, index);
  });

const currentSnapshotMatches = async (
  tx: TxScope,
  snapshot: PaymentChargeDecisionSnapshot,
  allowRefundProgress: boolean,
): Promise<boolean> => {
  const indexes = await paymentDecisionChargeIndexes(snapshot);
  const payment = await loadPaymentState(tx, snapshot.paymentId);
  const charges = await loadChargeStates(tx, snapshot.paymentId);
  return (
    payment?.origin === "current" &&
    payment.provider === snapshot.provider &&
    payment.mode === snapshot.mode &&
    payment.account_id === snapshot.accountId &&
    allChargesMatch(charges, snapshot.charges, (charge, expected, index) =>
      Boolean(
        charge.id === expected.chargeId &&
          charge.origin === "current" &&
          charge.reference_index === indexes[index] &&
          moneyMatches(
            charge.captured_amount,
            charge.currency,
            expected.captured,
          ) &&
          charge.currency === expected.refunded.currency &&
          (allowRefundProgress
            ? charge.refunded_amount !== null &&
              charge.refunded_amount >= expected.refunded.amount
            : charge.refunded_amount === expected.refunded.amount),
      ),
    )
  );
};

const legacyAccountMatches = (
  payment: PaymentStateRow,
  selection: PaymentCaseDecision["claim"]["selection"],
): boolean =>
  selection.kind === "assign_provider"
    ? (payment.provider === null &&
        payment.mode === null &&
        payment.account_id === null) ||
      (payment.provider === selection.provider &&
        payment.mode === selection.mode &&
        payment.account_id === selection.accountId)
    : selection.kind === "keep_legacy_payment" &&
      payment.provider !== null &&
      payment.mode !== null &&
      payment.account_id !== null;

const originalLegacyChargesMatch = (
  charges: ChargeStateRow[],
  snapshot: PaymentLegacyDecisionSnapshot,
): boolean =>
  allChargesMatch(charges, snapshot.charges, (charge, expected) =>
    Boolean(
      charge.id === expected.chargeId &&
        charge.origin === "legacy" &&
        charge.provider_reference === expected.providerReference,
    ),
  );

const legacySnapshotMatches = async (
  tx: TxScope,
  decision: PaymentCaseDecision,
  snapshot: PaymentLegacyDecisionSnapshot,
): Promise<boolean> => {
  const payment = await loadPaymentState(tx, snapshot.paymentId);
  if (payment?.origin !== "legacy") return false;
  const selection = decision.claim.selection;
  if (!legacyAccountMatches(payment, selection)) return false;
  const charges = await loadChargeStates(tx, snapshot.paymentId);
  if (originalLegacyChargesMatch(charges, snapshot)) return true;
  const read =
    decision.decision?.kind === "assign_provider"
      ? decision.decision.read
      : null;
  if (
    selection.kind !== "assign_provider" ||
    read?.status !== "attached" ||
    charges.length !== 1
  ) {
    return false;
  }
  const [charge] = charges;
  if (charge === undefined) return false;
  const [index] = await paymentDecisionChargeIndexes({
    accountId: selection.accountId,
    charges: [
      {
        captured: read.captured,
        chargeId: charge.id,
        providerReference: read.charge,
        refunded: read.refunded,
      },
    ],
    kind: "charges",
    mode: selection.mode,
    paymentId: snapshot.paymentId,
    provider: selection.provider,
  });
  return (
    charge.origin === "current" &&
    charge.reference_index === index &&
    moneyMatches(charge.captured_amount, charge.currency, read.captured) &&
    moneyMatches(charge.refunded_amount, charge.currency, read.refunded)
  );
};

const snapshotMatches = (
  tx: TxScope,
  decision: PaymentCaseDecision,
): Promise<boolean> =>
  decision.claim.reviewed.kind === "charges"
    ? currentSnapshotMatches(
        tx,
        decision.claim.reviewed,
        decision.attemptCount > 0,
      )
    : legacySnapshotMatches(tx, decision, decision.claim.reviewed);

const closeStaleDecision = async (
  tx: TxScope,
  decision: PaymentCaseDecision,
  caseState: CaseStateRow | undefined,
): Promise<"completed" | "review_again"> => {
  if (
    caseState?.state === "needs_action" &&
    caseState.revision === decision.claim.caseRevision
  ) {
    await tx.execute({
      args: [decision.paymentCaseId, decision.claim.caseRevision],
      sql: `UPDATE payment_cases SET revision = revision + 1
             WHERE id = ? AND revision = ? AND state = 'needs_action'`,
    });
  }
  await tx.execute({
    args: [decision.id],
    sql: `UPDATE payment_case_decisions
             SET state = 'completed', next_retry_at = NULL, last_error = NULL
           WHERE id = ? AND state != 'completed'`,
  });
  return caseState?.state === "resolved" ? "completed" : "review_again";
};

const runningAttempt = (
  decision: PaymentCaseDecision,
  attemptedAt: number,
): PaymentDecisionAttempt => ({
  decision: {
    ...decision,
    attemptCount: decision.attemptCount + 1,
    lastAttemptAt: attemptedAt,
    nextRetryAt: null,
    state: "running",
  },
  status: "running",
});

export const beginPaymentDecisionAttempt = async (
  decisionId: number,
  attemptedAt = Date.now(),
  knownDecision?: PaymentCaseDecision,
): Promise<PaymentDecisionAttempt> => {
  const decision = knownDecision ?? (await getPaymentDecisionById(decisionId));
  if (await claimPaymentDecisionAttempt(decision, attemptedAt)) {
    return runningAttempt(decision, attemptedAt);
  }
  const status = await withTransaction(async (tx) => {
    const decisionResult = await tx.execute({
      args: [decisionId],
      sql: `SELECT state, attempt_count, last_attempt_at, next_retry_at
              FROM payment_case_decisions WHERE id = ?`,
    });
    const [state] = resultRows<DecisionStateRow>(decisionResult);
    if (state === undefined || state.state === "completed") return "completed";
    if (!isDue(state, attemptedAt)) return "busy";
    const caseState = await loadCaseState(tx, decision.paymentCaseId);
    if (
      caseState?.state !== "needs_action" ||
      caseState.revision !== decision.claim.caseRevision ||
      !(await snapshotMatches(tx, decision))
    ) {
      return closeStaleDecision(tx, decision, caseState);
    }
    await tx.execute({
      args: [attemptedAt, decisionId],
      sql: `UPDATE payment_case_decisions
               SET state = 'running', attempt_count = attempt_count + 1,
                   last_attempt_at = ?, next_retry_at = NULL, last_error = NULL
             WHERE id = ?`,
    });
    return "running";
  });
  if (status !== "running") return { status };
  return runningAttempt(decision, attemptedAt);
};

export const getDuePaymentDecisions = async (
  dueAt = Date.now(),
  limit = PAYMENT_DECISION_PAGE_SIZE,
): Promise<DuePaymentDecision[]> =>
  (
    await queryAll<{ case_id: number; id: number }>(
      `SELECT id, case_id FROM payment_case_decisions
        WHERE state = 'accepted'
           OR (state = 'retrying' AND next_retry_at <= ?)
           OR (state = 'running' AND last_attempt_at <= ?)
        ORDER BY COALESCE(next_retry_at, last_attempt_at, 0), id LIMIT ?`,
      [dueAt, dueAt - PAYMENT_DECISION_LEASE_MS, limit],
    )
  ).map((row) => ({ caseId: Number(row.case_id), id: Number(row.id) }));

export const reviewPaymentDecisionAgain = async (
  decision: PaymentCaseDecision,
): Promise<void> =>
  withTransaction(async (tx) => {
    await closeStaleDecision(
      tx,
      decision,
      await loadCaseState(tx, decision.paymentCaseId),
    );
  });
