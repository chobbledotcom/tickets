import type { InValue } from "@libsql/client";
import { executeBatchWithResults } from "#shared/db/client.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import type { PaymentCaseDecision } from "#shared/db/payments/types.ts";
import type {
  PaymentChargeDecisionSnapshot,
  PaymentLegacyDecisionSnapshot,
} from "#shared/payment-state/lifecycle.ts";

export const PAYMENT_DECISION_LEASE_MS = 5 * 60 * 1_000;

type SnapshotCondition = { args: InValue[]; sql: string };
export const paymentDecisionChargeIndexes = (
  snapshot: PaymentChargeDecisionSnapshot,
): Promise<string[]> =>
  Promise.all(
    snapshot.charges.map((charge) =>
      paymentStoredJson.chargeResource.index(
        charge.providerReference,
        "payment decision charge review",
      ),
    ),
  );

const chargeCondition = (
  paymentId: string,
  charge: PaymentChargeDecisionSnapshot["charges"][number],
  referenceIndex: string,
  allowRefundProgress: boolean,
): SnapshotCondition => ({
  args: [
    paymentId,
    charge.chargeId,
    referenceIndex,
    charge.captured.amount,
    charge.captured.currency,
    charge.refunded.amount,
    charge.refunded.currency,
  ],
  sql: `EXISTS (
    SELECT 1 FROM payment_charges AS reviewedCharge
     WHERE reviewedCharge.payment_id = ? AND reviewedCharge.id = ?
       AND reviewedCharge.origin = 'current'
       AND reviewedCharge.reference_index = ?
       AND reviewedCharge.captured_amount = ?
       AND reviewedCharge.currency = ?
       AND reviewedCharge.refunded_amount ${allowRefundProgress ? ">=" : "="} ?
       AND reviewedCharge.currency = ?
  )`,
});

const currentSnapshotCondition = async (
  snapshot: PaymentChargeDecisionSnapshot,
  allowRefundProgress: boolean,
): Promise<SnapshotCondition> => {
  const indexes = await paymentDecisionChargeIndexes(snapshot);
  const charges = snapshot.charges.map((charge, index) => {
    const referenceIndex = indexes[index];
    if (referenceIndex === undefined) {
      throw new Error(`Payment charge ${charge.chargeId} has no review index`);
    }
    return chargeCondition(
      snapshot.paymentId,
      charge,
      referenceIndex,
      allowRefundProgress,
    );
  });
  return {
    args: [
      snapshot.paymentId,
      snapshot.provider,
      snapshot.mode,
      snapshot.accountId,
      snapshot.paymentId,
      snapshot.charges.length,
      ...charges.flatMap((condition) => condition.args),
    ],
    sql: `EXISTS (
      SELECT 1 FROM payment_sessions AS reviewedPayment
       WHERE reviewedPayment.id = ? AND reviewedPayment.origin = 'current'
         AND reviewedPayment.provider = ? AND reviewedPayment.mode = ?
         AND reviewedPayment.account_id = ?
    ) AND (
      SELECT COUNT(*) FROM payment_charges AS countedCharge
       WHERE countedCharge.payment_id = ?
    ) = ? AND ${charges.map((condition) => condition.sql).join(" AND ")}`,
  };
};

const originalLegacyCondition = (
  snapshot: PaymentLegacyDecisionSnapshot,
): SnapshotCondition => ({
  args: [
    snapshot.paymentId,
    snapshot.charges.length,
    ...snapshot.charges.flatMap((charge) => [
      snapshot.paymentId,
      charge.chargeId,
      charge.providerReference,
    ]),
  ],
  sql: `(
    SELECT COUNT(*) FROM payment_charges AS countedCharge
     WHERE countedCharge.payment_id = ?
  ) = ? AND ${snapshot.charges
    .map(
      () =>
        `EXISTS (
    SELECT 1 FROM payment_charges AS reviewedCharge
     WHERE reviewedCharge.payment_id = ? AND reviewedCharge.id = ?
       AND reviewedCharge.origin = 'legacy'
       AND reviewedCharge.provider_reference = ?
  )`,
    )
    .join(" AND ")}`,
});

const legacySnapshotCondition = (
  decision: PaymentCaseDecision,
  snapshot: PaymentLegacyDecisionSnapshot,
): SnapshotCondition => {
  const selection = decision.claim.selection;
  const accountArgs =
    selection.kind === "assign_provider"
      ? [selection.provider, selection.mode, selection.accountId]
      : [];
  const accountSql =
    selection.kind === "assign_provider"
      ? `((reviewedPayment.provider IS NULL AND reviewedPayment.mode IS NULL
          AND reviewedPayment.account_id IS NULL)
        OR (reviewedPayment.provider = ? AND reviewedPayment.mode = ?
          AND reviewedPayment.account_id = ?))`
      : `(reviewedPayment.provider IS NOT NULL AND reviewedPayment.mode IS NOT NULL
        AND reviewedPayment.account_id IS NOT NULL)`;
  const original = originalLegacyCondition(snapshot);
  return {
    args: [snapshot.paymentId, ...accountArgs, ...original.args],
    sql: `EXISTS (
      SELECT 1 FROM payment_sessions AS reviewedPayment
       WHERE reviewedPayment.id = ? AND reviewedPayment.origin = 'legacy'
         AND ${accountSql}
    ) AND (${original.sql})`,
  };
};

export const claimPaymentDecisionAttempt = async (
  decision: PaymentCaseDecision,
  attemptedAt: number,
): Promise<boolean> => {
  const snapshot =
    decision.claim.reviewed.kind === "charges"
      ? await currentSnapshotCondition(
          decision.claim.reviewed,
          decision.attemptCount > 0,
        )
      : legacySnapshotCondition(decision, decision.claim.reviewed);
  const [result] = await executeBatchWithResults([
    {
      args: [
        attemptedAt,
        decision.id,
        attemptedAt,
        attemptedAt - PAYMENT_DECISION_LEASE_MS,
        decision.paymentCaseId,
        decision.claim.caseRevision,
        ...snapshot.args,
      ],
      sql: `UPDATE payment_case_decisions
        SET state = 'running', attempt_count = attempt_count + 1,
            last_attempt_at = ?, next_retry_at = NULL, last_error = NULL
      WHERE id = ?
        AND (state = 'accepted'
          OR (state = 'retrying' AND next_retry_at <= ?)
          OR (state = 'running' AND last_attempt_at <= ?))
        AND EXISTS (
          SELECT 1 FROM payment_cases AS reviewedCase
           WHERE reviewedCase.id = ? AND reviewedCase.revision = ?
             AND reviewedCase.state = 'needs_action'
        )
        AND ${snapshot.sql}`,
    },
  ]);
  return result?.rowsAffected === 1;
};
