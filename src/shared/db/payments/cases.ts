import type { InValue } from "@libsql/client";
import * as v from "valibot";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  queryAll,
  queryOne,
  requireOne,
  type SqlStatement,
} from "#shared/db/client.ts";
import {
  openPaymentCaseData,
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
  sealPaymentCaseData,
} from "#shared/db/payments/codecs.ts";
import {
  type PaymentCase,
  PaymentCaseEvidenceSchema,
  type PaymentCaseObservation,
  PaymentCaseResourceSchema,
  PaymentCaseSchema,
  type PaymentCaseUpdate,
  StoredPaymentIntegerSchema,
} from "#shared/db/payments/types.ts";
import { PaymentCaseStateSchema } from "#shared/payment-state/lifecycle.ts";
import { ResourceIdSchema } from "#shared/payment-state/resources.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

const PAYMENT_CASE_ALERT_COUNT = 3;
const PAYMENT_CASE_ALERT_AGE_MS = 15 * 60 * 1000;

export const PAYMENT_CASE_COLUMNS = [
  "id",
  "payment_id",
  "resource",
  "reason",
  "state",
  "first_observed_at",
  "last_observed_at",
  "next_reconcile_at",
  "consecutive_count",
  "alerted_at",
  "evidence",
  "revision",
  "resolved_at",
  "alerted_revision",
  "alert_sent_at",
  "alert_sent_revision",
] as const;
const columnsSql = PAYMENT_CASE_COLUMNS.join(", ");

export interface StoredPaymentCaseRow {
  alert_sent_at: number | null;
  alert_sent_revision: number | null;
  alerted_at: number | null;
  alerted_revision: number | null;
  consecutive_count: number;
  evidence: EnvKeyEncrypted;
  first_observed_at: number;
  id: number;
  last_observed_at: number;
  next_reconcile_at: number | null;
  payment_id: string;
  reason: string;
  resolved_at: number | null;
  resource: EnvKeyEncrypted;
  revision: number;
  state: v.InferOutput<typeof PaymentCaseStateSchema>;
}

const StoredPaymentCaseRowSchema = v.strictObject({
  alert_sent_at: v.nullable(StoredPaymentIntegerSchema),
  alert_sent_revision: v.nullable(StoredPaymentIntegerSchema),
  alerted_at: v.nullable(StoredPaymentIntegerSchema),
  alerted_revision: v.nullable(StoredPaymentIntegerSchema),
  consecutive_count: StoredPaymentIntegerSchema,
  evidence: v.string(),
  first_observed_at: StoredPaymentIntegerSchema,
  id: StoredPaymentIntegerSchema,
  last_observed_at: StoredPaymentIntegerSchema,
  next_reconcile_at: v.nullable(StoredPaymentIntegerSchema),
  payment_id: ResourceIdSchema,
  reason: ResourceIdSchema,
  resolved_at: v.nullable(StoredPaymentIntegerSchema),
  resource: v.string(),
  revision: StoredPaymentIntegerSchema,
  state: PaymentCaseStateSchema,
});

export const readPaymentCaseRow = async (
  row: StoredPaymentCaseRow,
): Promise<PaymentCase> => {
  v.parse(StoredPaymentCaseRowSchema, row);
  const { resource, evidence } = await openPaymentCaseData(
    row.resource,
    row.evidence,
    row.id,
  );
  return v.parse(PaymentCaseSchema, {
    alertedAt: row.alerted_at,
    alertSentAt: row.alert_sent_at,
    alertSentRevision: row.alert_sent_revision,
    consecutiveCount: row.consecutive_count,
    evidence,
    firstObservedAt: row.first_observed_at,
    id: row.id,
    lastObservedAt: row.last_observed_at,
    nextReconcileAt: row.next_reconcile_at,
    paymentId: row.payment_id,
    reason: row.reason,
    resolvedAt: row.resolved_at,
    resource,
    revision: row.revision,
    state: row.state,
  });
};

const observationSchema = v.pipe(
  v.strictObject({
    evidence: PaymentCaseEvidenceSchema,
    nextReconcileAt: v.nullable(integerAtLeast(0)),
    paymentId: ResourceIdSchema,
    reason: ResourceIdSchema,
    resource: PaymentCaseResourceSchema,
    state: v.picklist(["retrying", "needs_action"]),
  }),
  v.check(
    (observation) =>
      (observation.state === "retrying") ===
      (observation.nextReconcileAt !== null),
    "Only retrying payment cases have a next reconcile time",
  ),
);

export const paymentCaseStatement = async (
  observationValue: PaymentCaseObservation,
  observedAt = Date.now(),
): Promise<SqlStatement> => {
  const observation = v.parse(observationSchema, observationValue);
  const at = v.parse(integerAtLeast(0), observedAt);
  const { encryptedEvidence, encryptedResource, resourceIndex } =
    await sealPaymentCaseData(observation.resource, observation.evidence);
  const initialAlertedAt = observation.state === "needs_action" ? at : null;
  const initialAlertedRevision =
    observation.state === "needs_action" ? 1 : null;
  return {
    args: [
      observation.paymentId,
      encryptedResource,
      resourceIndex,
      observation.reason,
      observation.state,
      at,
      at,
      observation.nextReconcileAt,
      initialAlertedAt,
      initialAlertedRevision,
      encryptedEvidence,
      PAYMENT_CASE_ALERT_COUNT,
      PAYMENT_CASE_ALERT_AGE_MS,
      PAYMENT_CASE_ALERT_COUNT,
      PAYMENT_CASE_ALERT_AGE_MS,
      PAYMENT_CASE_ALERT_COUNT,
      PAYMENT_CASE_ALERT_AGE_MS,
      PAYMENT_CASE_ALERT_COUNT,
      PAYMENT_CASE_ALERT_AGE_MS,
    ],
    sql: `INSERT INTO payment_cases
      (payment_id, resource, resource_index, reason, state,
       first_observed_at, last_observed_at, next_reconcile_at,
       consecutive_count, alerted_at, alerted_revision, evidence,
       revision, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, NULL)
     ON CONFLICT(payment_id, resource_index) DO UPDATE SET
       resource = excluded.resource,
       reason = excluded.reason,
       state = CASE
         WHEN excluded.state = 'needs_action' THEN 'needs_action'
         WHEN payment_cases.state = 'resolved'
           OR payment_cases.reason != excluded.reason THEN 'retrying'
         WHEN payment_cases.state = 'needs_action' THEN 'needs_action'
         WHEN payment_cases.consecutive_count + 1 >= ?
           AND excluded.last_observed_at - payment_cases.first_observed_at >= ?
         THEN 'needs_action'
         ELSE 'retrying'
       END,
       first_observed_at = CASE
         WHEN payment_cases.state = 'resolved'
           OR payment_cases.reason != excluded.reason
         THEN excluded.first_observed_at
         ELSE payment_cases.first_observed_at
       END,
       last_observed_at = excluded.last_observed_at,
       next_reconcile_at = CASE
         WHEN excluded.state = 'needs_action' THEN NULL
         WHEN payment_cases.state != 'resolved'
           AND payment_cases.reason = excluded.reason
           AND (payment_cases.state = 'needs_action'
             OR (payment_cases.consecutive_count + 1 >= ?
               AND excluded.last_observed_at - payment_cases.first_observed_at >= ?))
         THEN NULL
         ELSE excluded.next_reconcile_at
       END,
       consecutive_count = CASE
         WHEN payment_cases.state = 'resolved'
           OR payment_cases.reason != excluded.reason THEN 1
         ELSE payment_cases.consecutive_count + 1
       END,
       alerted_at = CASE
         WHEN excluded.state = 'needs_action'
           AND (payment_cases.state = 'resolved'
             OR payment_cases.reason != excluded.reason
             OR payment_cases.state != 'needs_action')
         THEN excluded.alerted_at
         WHEN excluded.state = 'retrying'
           AND payment_cases.state != 'resolved'
           AND payment_cases.reason = excluded.reason
           AND payment_cases.state != 'needs_action'
           AND payment_cases.consecutive_count + 1 >= ?
           AND excluded.last_observed_at - payment_cases.first_observed_at >= ?
         THEN excluded.last_observed_at
         WHEN payment_cases.state = 'resolved'
           OR payment_cases.reason != excluded.reason THEN NULL
         ELSE payment_cases.alerted_at
       END,
        alerted_revision = CASE
         WHEN excluded.state = 'needs_action'
           AND (payment_cases.state = 'resolved'
             OR payment_cases.reason != excluded.reason
             OR payment_cases.state != 'needs_action')
         THEN payment_cases.revision + 1
         WHEN excluded.state = 'retrying'
           AND payment_cases.state != 'resolved'
           AND payment_cases.reason = excluded.reason
           AND payment_cases.state != 'needs_action'
           AND payment_cases.consecutive_count + 1 >= ?
           AND excluded.last_observed_at - payment_cases.first_observed_at >= ?
         THEN payment_cases.revision + 1
         WHEN payment_cases.state = 'resolved'
           OR payment_cases.reason != excluded.reason THEN NULL
         ELSE payment_cases.alerted_revision
         END,
        alert_sent_at = CASE
          WHEN payment_cases.state = 'resolved'
            OR payment_cases.reason != excluded.reason
            OR (excluded.state = 'needs_action'
              AND payment_cases.state != 'needs_action')
          THEN NULL
          ELSE payment_cases.alert_sent_at
        END,
        alert_sent_revision = CASE
          WHEN payment_cases.state = 'resolved'
            OR payment_cases.reason != excluded.reason
            OR (excluded.state = 'needs_action'
              AND payment_cases.state != 'needs_action')
          THEN NULL
          ELSE payment_cases.alert_sent_revision
        END,
        alert_lease_token = CASE
          WHEN payment_cases.state = 'resolved'
            OR payment_cases.reason != excluded.reason
            OR (excluded.state = 'needs_action'
              AND payment_cases.state != 'needs_action')
          THEN NULL
          ELSE payment_cases.alert_lease_token
        END,
        alert_lease_expires_at = CASE
          WHEN payment_cases.state = 'resolved'
            OR payment_cases.reason != excluded.reason
            OR (excluded.state = 'needs_action'
              AND payment_cases.state != 'needs_action')
          THEN NULL
          ELSE payment_cases.alert_lease_expires_at
        END,
        evidence = excluded.evidence,
        revision = payment_cases.revision + 1,
       resolved_at = NULL
      RETURNING ${columnsSql}`,
  };
};

export const recordPaymentCase = async (
  observation: PaymentCaseObservation,
  observedAt = Date.now(),
): Promise<PaymentCaseUpdate> => {
  const statement = await paymentCaseStatement(observation, observedAt);
  const row = await requireOne<StoredPaymentCaseRow>(
    statement.sql,
    statement.args,
  );
  return {
    alerted: row.alerted_revision === row.revision,
    paymentCase: await readPaymentCaseRow(row),
  };
};

const RESOLVE_CASE_SET = `state = 'resolved',
  next_reconcile_at = NULL,
  resolved_at = ?,
  alert_lease_token = NULL,
  alert_lease_expires_at = NULL,
  revision = revision + 1`;

const paymentCaseResourceIndex = (
  resource: v.InferInput<typeof PaymentCaseResourceSchema>,
): Promise<string> =>
  paymentStoredJson.caseResource.index(
    resource,
    PAYMENT_STORAGE_CONTEXT.caseResourceResolution,
  );

const caseResolutionStatement = (
  where: string,
  whereArgs: InValue[],
  resolvedAt: number,
): SqlStatement => ({
  args: [v.parse(integerAtLeast(0), resolvedAt), ...whereArgs],
  sql: `UPDATE payment_cases SET ${RESOLVE_CASE_SET}
         WHERE ${where} AND state != 'resolved'`,
});

type PaymentCaseResourceValue = v.InferInput<typeof PaymentCaseResourceSchema>;

type PaymentCaseResourceOperation<Result> = (
  paymentId: string,
  resource: PaymentCaseResourceValue,
  resolvedAt?: number,
) => Promise<Result>;

const forPaymentCaseResource =
  <Result>(
    finish: (statement: SqlStatement) => Promise<Result>,
  ): PaymentCaseResourceOperation<Result> =>
  async (paymentId, resource, resolvedAt = Date.now()) =>
    finish(
      caseResolutionStatement(
        "payment_id = ? AND resource_index = ?",
        [paymentId, await paymentCaseResourceIndex(resource)],
        resolvedAt,
      ),
    );

const resolutionSucceeded = async (statement: SqlStatement): Promise<boolean> =>
  (await execute(statement.sql, statement.args)).rowsAffected === 1;

export const paymentCaseResolutionStatement: PaymentCaseResourceOperation<SqlStatement> =
  forPaymentCaseResource((statement) => Promise.resolve(statement));

export const resolvePaymentCaseForResource: PaymentCaseResourceOperation<boolean> =
  forPaymentCaseResource(resolutionSucceeded);

export const getPaymentCaseByIdOrNull = async (
  caseId: number,
): Promise<PaymentCase | null> => {
  const row = await queryOne<StoredPaymentCaseRow>(
    `SELECT ${columnsSql} FROM payment_cases WHERE id = ?`,
    [v.parse(integerAtLeast(1), caseId)],
  );
  return row === null ? null : readPaymentCaseRow(row);
};

/** List unresolved cases in operator order: action first, then oldest retry. */
export const getOpenPaymentCases = async (): Promise<PaymentCase[]> =>
  Promise.all(
    (
      await queryAll<StoredPaymentCaseRow>(
        `SELECT ${columnsSql} FROM payment_cases
          WHERE state IN ('needs_action', 'retrying')
          ORDER BY CASE state WHEN 'needs_action' THEN 0 ELSE 1 END,
                   first_observed_at, id`,
      )
    ).map(readPaymentCaseRow),
  );
