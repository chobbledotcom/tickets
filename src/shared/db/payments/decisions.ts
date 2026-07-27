/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryAll, queryOne } from "#shared/db/client.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import type { PaymentCaseDecision } from "#shared/db/payments/types.ts";
import { PaymentCaseDecisionSchema } from "#shared/db/payments/types.ts";
import {
  PaymentDecisionStateSchema,
  type PaymentOperatorDecision,
  type PaymentOperatorDecisionClaim,
  PaymentOperatorDecisionClaimSchema,
  PaymentOperatorDecisionSchema,
} from "#shared/payment-state/lifecycle.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/* jscpd:ignore-end */

const DECISION_COLUMNS = [
  "id",
  "case_id",
  "claim",
  "decision",
  "state",
  "attempt_count",
  "last_attempt_at",
  "next_retry_at",
] as const;
const columnsSql = DECISION_COLUMNS.join(", ");
const DecisionIdSchema = integerAtLeast(1);
const DecisionTimeSchema = integerAtLeast(0);

type StoredDecisionRow = {
  attempt_count: number;
  case_id: number;
  claim: EnvKeyEncrypted;
  decision: EnvKeyEncrypted | null;
  id: number;
  last_attempt_at: number | null;
  next_retry_at: number | null;
  state: v.InferOutput<typeof PaymentDecisionStateSchema>;
};

const StoredDecisionRowSchema = v.strictObject({
  attempt_count: integerAtLeast(0),
  case_id: DecisionIdSchema,
  claim: v.string(),
  decision: v.nullable(v.string()),
  id: DecisionIdSchema,
  last_attempt_at: v.nullable(DecisionTimeSchema),
  next_retry_at: v.nullable(DecisionTimeSchema),
  state: PaymentDecisionStateSchema,
});

const readDecision = async (
  rowValue: StoredDecisionRow,
): Promise<PaymentCaseDecision> => {
  v.parse(StoredDecisionRowSchema, rowValue);
  const row = rowValue;
  const [claim, decision] = await Promise.all([
    paymentStoredJson.decisionClaim.open(
      row.claim,
      `payment_case_decisions.claim for ${row.id}`,
    ),
    row.decision === null
      ? Promise.resolve(null)
      : paymentStoredJson.decision.open(
          row.decision,
          `payment_case_decisions.decision for ${row.id}`,
        ),
  ]);
  return v.parse(PaymentCaseDecisionSchema, {
    attemptCount: row.attempt_count,
    claim,
    decision,
    id: row.id,
    lastAttemptAt: row.last_attempt_at,
    nextRetryAt: row.next_retry_at,
    paymentCaseId: row.case_id,
    state: row.state,
  });
};

export type PaymentDecisionRejection = "closed" | "duplicate" | "stale";

export class PaymentDecisionRejectedError extends Error {
  readonly reason: PaymentDecisionRejection;

  constructor(reason: PaymentDecisionRejection) {
    super(`Payment decision was rejected: ${reason}`);
    this.name = "PaymentDecisionRejectedError";
    this.reason = reason;
  }
}

const parseDecisionId = (value: number): number =>
  v.parse(DecisionIdSchema, value);

const parseDecisionTime = (value: number): number =>
  v.parse(DecisionTimeSchema, value);

const requireDecisionUpdate = (
  rowsAffected: number,
  decisionId: number,
  failure: string,
): void => {
  if (rowsAffected !== 1) {
    throw new Error(`Payment decision ${decisionId} ${failure}`);
  }
};

const rejectionFor = async (
  caseId: number,
  caseRevision: number,
): Promise<PaymentDecisionRejection> => {
  const row = await queryOne<{ current_revision: number; state: string }>(
    `SELECT revision AS current_revision, state
       FROM payment_cases WHERE id = ?`,
    [caseId],
  );
  if (row === null || row.state !== "needs_action") return "closed";
  return Number(row.current_revision) === caseRevision ? "duplicate" : "stale";
};

/** Accept one decision for the exact open case revision, once. */
export const acceptPaymentDecision = async (
  caseIdValue: number,
  claimValue: PaymentOperatorDecisionClaim,
  decisionValue: PaymentOperatorDecision,
): Promise<PaymentCaseDecision> => {
  const caseId = parseDecisionId(caseIdValue);
  const claim = v.parse(PaymentOperatorDecisionClaimSchema, claimValue);
  const decision = v.parse(PaymentOperatorDecisionSchema, decisionValue);
  const [storedClaim, storedDecision] = await Promise.all([
    paymentStoredJson.decisionClaim.seal(
      claim,
      PAYMENT_STORAGE_CONTEXT.decisionClaim,
    ),
    paymentStoredJson.decision.seal(decision, PAYMENT_STORAGE_CONTEXT.decision),
  ]);
  const row = await queryOne<StoredDecisionRow>(
    `INSERT OR IGNORE INTO payment_case_decisions
      (case_id, case_revision, claim, decision, state, attempt_count,
       created_at, last_attempt_at, next_retry_at, last_error)
     SELECT id, revision, ?, ?, 'accepted', 0, ?, NULL, NULL, NULL
       FROM payment_cases
      WHERE id = ? AND revision = ? AND state = 'needs_action'
     RETURNING ${columnsSql}`,
    [storedClaim, storedDecision, claim.claimedAt, caseId, claim.caseRevision],
  );
  if (row !== null) return readDecision(row);
  throw new PaymentDecisionRejectedError(
    await rejectionFor(caseId, claim.caseRevision),
  );
};

export const getPaymentCaseDecisions = async (
  caseId: number,
): Promise<PaymentCaseDecision[]> =>
  Promise.all(
    (
      await queryAll<StoredDecisionRow>(
        `SELECT ${columnsSql} FROM payment_case_decisions
          WHERE case_id = ? ORDER BY id`,
        [parseDecisionId(caseId)],
      )
    ).map(readDecision),
  );

export const getPaymentDecisionByIdOrNull = async (
  decisionId: number,
): Promise<PaymentCaseDecision | null> => {
  const row = await queryOne<StoredDecisionRow>(
    `SELECT ${columnsSql} FROM payment_case_decisions WHERE id = ?`,
    [parseDecisionId(decisionId)],
  );
  return row === null ? null : readDecision(row);
};

export const getPaymentDecisionById = async (
  decisionId: number,
): Promise<PaymentCaseDecision> => {
  const decision = await getPaymentDecisionByIdOrNull(decisionId);
  if (decision === null) {
    throw new Error(`Payment decision ${decisionId} was not found`);
  }
  return decision;
};

export const replaceRunningPaymentDecision = async (
  decisionId: number,
  decisionValue: PaymentOperatorDecision,
): Promise<void> => {
  const decision = v.parse(PaymentOperatorDecisionSchema, decisionValue);
  const stored = await paymentStoredJson.decision.seal(
    decision,
    PAYMENT_STORAGE_CONTEXT.decision,
  );
  const result = await execute(
    `UPDATE payment_case_decisions SET decision = ?
      WHERE id = ? AND state = 'running'`,
    [stored, parseDecisionId(decisionId)],
  );
  requireDecisionUpdate(
    result.rowsAffected,
    decisionId,
    "could not update its facts",
  );
};

export const retryPaymentDecision = async (
  decisionId: number,
  error: string,
  nextRetryAt: number,
): Promise<void> => {
  const storedError = await paymentStoredJson.decisionError.seal(
    error,
    PAYMENT_STORAGE_CONTEXT.decisionError,
  );
  const result = await execute(
    `UPDATE payment_case_decisions
        SET state = 'retrying', next_retry_at = ?, last_error = ?
      WHERE id = ? AND state = 'running'`,
    [parseDecisionTime(nextRetryAt), storedError, parseDecisionId(decisionId)],
  );
  requireDecisionUpdate(
    result.rowsAffected,
    decisionId,
    "could not be retried",
  );
};
