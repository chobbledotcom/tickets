import {
  execute,
  queryAll,
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import { getPaymentCaseDecisions } from "#shared/db/payments/decisions.ts";
import type { PaymentCaseDecision } from "#shared/db/payments/types.ts";

const DECISION_COMPLETION_SET =
  "state = 'completed', next_retry_at = NULL, last_error = NULL";

const caseChanged = (decision: PaymentCaseDecision): Error =>
  new Error(`Payment case ${decision.paymentCaseId} changed before completion`);

const resolveCaseRevision = async (
  tx: TxScope,
  decision: PaymentCaseDecision,
  completedAt: number,
  changed: "skip" | "throw",
): Promise<boolean> => {
  const result = await tx.execute({
    args: [completedAt, decision.paymentCaseId, decision.claim.caseRevision],
    sql: `UPDATE payment_cases
             SET state = 'resolved', next_reconcile_at = NULL, resolved_at = ?,
                 alert_lease_token = NULL, alert_lease_expires_at = NULL,
                 revision = revision + 1
           WHERE id = ? AND revision = ? AND state = 'needs_action'
           RETURNING id`,
  });
  if (result.rows.length === 1) return true;
  if (changed === "skip") return false;
  throw caseChanged(decision);
};

const completeRunningDecision = async (
  tx: TxScope,
  decisionId: number,
): Promise<void> => {
  const result = await tx.execute({
    args: [decisionId],
    sql: `UPDATE payment_case_decisions
             SET ${DECISION_COMPLETION_SET}
           WHERE id = ? AND state = 'running' AND decision IS NOT NULL
           RETURNING id`,
  });
  if (result.rows.length === 1) return;
  const state = await tx.execute({
    args: [decisionId],
    sql: "SELECT state FROM payment_case_decisions WHERE id = ?",
  });
  if (resultRows<{ state: string }>(state)[0]?.state !== "completed") {
    throw new Error(`Payment decision ${decisionId} could not be completed`);
  }
};

const completeWithCaseChange = (
  decision: PaymentCaseDecision,
  changeCase: (tx: TxScope) => Promise<void>,
): Promise<void> =>
  withTransaction(async (tx) => {
    await changeCase(tx);
    await completeRunningDecision(tx, decision.id);
  });

const defineCaseCompletion =
  <Args extends unknown[]>(
    changeCase: (
      tx: TxScope,
      decision: PaymentCaseDecision,
      ...args: Args
    ) => Promise<void>,
  ): ((decision: PaymentCaseDecision, ...args: Args) => Promise<void>) =>
  (decision, ...args) =>
    completeWithCaseChange(decision, (tx) => changeCase(tx, decision, ...args));

const atCompletionTime = (
  completedAt: number | undefined,
  complete: (resolvedAt: number) => Promise<void>,
): Promise<void> => complete(completedAt ?? Date.now());

const defineTimedPaymentWork =
  <Context>(
    complete: (context: Context, resolvedAt: number) => Promise<void>,
  ): ((context: Context, completedAt?: number) => Promise<void>) =>
  (context, completedAt) =>
    atCompletionTime(completedAt, (resolvedAt) =>
      complete(context, resolvedAt),
    );

const requireCaseResolution = async (
  tx: TxScope,
  decision: PaymentCaseDecision,
  resolvedAt: number,
): Promise<void> => {
  await resolveCaseRevision(tx, decision, resolvedAt, "throw");
};

type CompletePaymentDecisionWithNextCase = (
  decision: PaymentCaseDecision,
  reason: string,
) => Promise<void>;

type CompleteLegacyAssignment = (
  decision: PaymentCaseDecision,
  paymentId: string,
  completedAt?: number,
) => Promise<void>;

type CompleteRefundDecisionsForPayment = (
  paymentId: string,
  completedAt?: number,
) => Promise<void>;

type LegacyCompletionContext = {
  decision: PaymentCaseDecision;
  paymentId: string;
  tx: TxScope;
};

export const completePaymentDecisionAndResolveCase = async (
  decision: PaymentCaseDecision,
  completedAt?: number,
): Promise<void> => {
  const alreadyResolved = await execute(
    `UPDATE payment_case_decisions
        SET ${DECISION_COMPLETION_SET}
      WHERE id = ? AND state = 'running' AND decision IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM payment_cases
           WHERE id = ? AND state = 'resolved'
        )
      RETURNING id`,
    [decision.id, decision.paymentCaseId],
  );
  if (alreadyResolved.rows.length === 1) return;
  await completeWithCaseChange(decision, async (tx) => {
    const caseResult = await tx.execute({
      args: [decision.paymentCaseId],
      sql: "SELECT revision, state FROM payment_cases WHERE id = ?",
    });
    const paymentCase = resultRows<{ revision: number; state: string }>(
      caseResult,
    )[0];
    if (paymentCase?.state === "needs_action") {
      if (paymentCase.revision !== decision.claim.caseRevision) {
        throw caseChanged(decision);
      }
      await atCompletionTime(completedAt, async (resolvedAt) => {
        await requireCaseResolution(tx, decision, resolvedAt);
      });
    } else if (paymentCase?.state !== "resolved") {
      throw caseChanged(decision);
    }
  });
};

export const completePaymentDecisionWithNextCase: CompletePaymentDecisionWithNextCase =
  defineCaseCompletion(
    async (
      tx: TxScope,
      decision: PaymentCaseDecision,
      reason: string,
    ): Promise<void> => {
      const changed = await tx.execute({
        args: [reason, decision.paymentCaseId, decision.claim.caseRevision],
        sql: `UPDATE payment_cases
               SET reason = ?, revision = revision + 1
             WHERE id = ? AND revision = ? AND state = 'needs_action'
             RETURNING id`,
      });
      if (changed.rows.length !== 1) {
        throw caseChanged(decision);
      }
    },
  );

const completeLegacyCaseAt = defineTimedPaymentWork(
  async (
    { decision, paymentId, tx }: LegacyCompletionContext,
    resolvedAt: number,
  ): Promise<void> => {
    await requireCaseResolution(tx, decision, resolvedAt);
    await tx.execute({
      args: [resolvedAt, paymentId, decision.paymentCaseId],
      sql: `UPDATE payment_cases
               SET state = 'resolved', next_reconcile_at = NULL, resolved_at = ?,
                   revision = revision + 1
             WHERE payment_id = ? AND id != ? AND state != 'resolved'
               AND reason IN ('legacy_provider_unknown',
                 'legacy_mapping_ambiguous', 'legacy_refund_amount_unknown')`,
    });
  },
);

export const completeLegacyAssignment: CompleteLegacyAssignment =
  defineCaseCompletion(
    async (
      tx: TxScope,
      decision: PaymentCaseDecision,
      paymentId: string,
      completedAt?: number,
    ): Promise<void> =>
      completeLegacyCaseAt({ decision, paymentId, tx }, completedAt),
  );

/** Close saved refund decisions atomically when shared refund work succeeds. */
export const completeRefundDecisionsForPayment: CompleteRefundDecisionsForPayment =
  defineTimedPaymentWork(
    async (paymentId: string, resolvedAt: number): Promise<void> => {
      const cases = await queryAll<{ id: number }>(
        `SELECT paymentDecision.case_id AS id
       FROM payment_case_decisions AS paymentDecision
       JOIN payment_cases AS paymentCase ON paymentCase.id = paymentDecision.case_id
      WHERE paymentCase.payment_id = ? AND paymentDecision.state = 'retrying'
      ORDER BY paymentDecision.id`,
        [paymentId],
      );
      for (const { id } of cases) {
        const decision = (await getPaymentCaseDecisions(Number(id))).find(
          (candidate) =>
            candidate.state === "retrying" &&
            (candidate.claim.selection.kind === "refund_remaining" ||
              candidate.claim.selection.kind === "confirm_fully_refunded"),
        );
        if (decision === undefined) continue;
        await withTransaction(async (tx) => {
          if (!(await resolveCaseRevision(tx, decision, resolvedAt, "skip"))) {
            return;
          }
          const completed = await tx.execute({
            args: [decision.id],
            sql: `UPDATE payment_case_decisions
                 SET ${DECISION_COMPLETION_SET}
               WHERE id = ? AND state = 'retrying' RETURNING id`,
          });
          if (completed.rows.length !== 1) {
            throw new Error(
              `Payment decision ${decision.id} could not be completed`,
            );
          }
        });
      }
    },
  );
