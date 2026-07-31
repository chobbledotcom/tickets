import * as v from "valibot";
import { mapParallel, unique } from "#fp";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
  sealPaymentCaseData,
} from "#shared/db/payments/codecs.ts";
import type { LegacyPaymentRuntime } from "#shared/db/payments/legacy.ts";
import type { PaymentCaseEvidence } from "#shared/db/payments/types.ts";
import type { PaymentAccount } from "#shared/payment-runtime/account.ts";
import { PaymentSessionStateSchema } from "#shared/payment-state/lifecycle.ts";
import {
  type PaymentMode,
  PaymentModeSchema,
} from "#shared/payment-state/observation.ts";
import type { ProviderSessionResource } from "#shared/payment-state/resources.ts";
import {
  PaymentProviderSchema,
  type PaymentProviderType,
} from "#shared/types.ts";

export interface LegacySessionRow {
  account_id: string | null;
  attendee_id: number | null;
  id: string;
  legacy_runtime: EnvKeyEncrypted;
  mode: string | null;
  provider: string | null;
  revision: number;
  state: string;
}

export type LegacyPaymentReplay = {
  accountId: string | null;
  attendeeId: number | null;
  id: string;
  mode: PaymentMode | null;
  provider: PaymentProviderType | null;
  revision: number;
  runtime: LegacyPaymentRuntime;
  state: v.InferOutput<typeof PaymentSessionStateSchema>;
};

export const readLegacySession = async (
  row: LegacySessionRow,
): Promise<LegacyPaymentReplay> => ({
  accountId: row.account_id,
  attendeeId: row.attendee_id,
  id: row.id,
  mode: row.mode === null ? null : v.parse(PaymentModeSchema, row.mode),
  provider:
    row.provider === null ? null : v.parse(PaymentProviderSchema, row.provider),
  revision: row.revision,
  runtime: await paymentStoredJson.legacyRuntime.open(
    row.legacy_runtime,
    `payment_sessions.legacy_runtime for ${row.id}`,
  ),
  state: v.parse(PaymentSessionStateSchema, row.state),
});

export const getLegacyPaymentsByIds = async (
  ids: readonly string[],
): Promise<LegacyPaymentReplay[]> => {
  const distinct = unique([...ids]);
  if (distinct.length === 0) return [];
  const rows = await queryAll<LegacySessionRow>(
    `SELECT id, provider, mode, account_id, state, revision, attendee_id,
            legacy_runtime
       FROM payment_sessions
      WHERE origin = 'legacy' AND id IN (${inPlaceholders(distinct)})
      ORDER BY id`,
    distinct,
  );
  return mapParallel(readLegacySession)(rows);
};

const legacyIdsForReference = async (reference: string): Promise<string[]> => [
  `legacy:session:${await hmacHash(`session:${reference}`)}`,
  `legacy:sumup:${await hmacHash(reference)}`,
];

export const getLegacyPaymentsByReferences = async (
  references: readonly string[],
): Promise<LegacyPaymentReplay[]> => {
  const ids = (
    await mapParallel(legacyIdsForReference)(unique([...references]))
  ).flat();
  return getLegacyPaymentsByIds(ids);
};

export const getLegacyPaymentsByResource = async (
  resource: ProviderSessionResource,
): Promise<LegacyPaymentReplay[]> => {
  const resourceIndex = await paymentStoredJson.caseResource.index(
    resource,
    PAYMENT_STORAGE_CONTEXT.caseResourceResolution,
  );
  const rows = await queryAll<{ payment_id: string }>(
    `SELECT paymentCase.payment_id
       FROM payment_cases AS paymentCase
       JOIN payment_sessions AS paymentSession
         ON paymentSession.id = paymentCase.payment_id
      WHERE paymentSession.origin = 'legacy'
        AND paymentCase.resource_index = ?
      ORDER BY paymentCase.payment_id`,
    [resourceIndex],
  );
  return getLegacyPaymentsByIds(rows.map((row) => row.payment_id));
};

type SealedPaymentCaseData = Awaited<ReturnType<typeof sealPaymentCaseData>>;

const legacyCaseStatement = async (
  paymentId: string,
  resource: ProviderSessionResource,
  evidence: PaymentCaseEvidence,
  build: (stored: SealedPaymentCaseData) => SqlStatement,
): Promise<SqlStatement> => {
  const stored = await sealPaymentCaseData(resource, evidence);
  const statement = build(stored);
  return {
    ...statement,
    args: [
      paymentId,
      stored.encryptedResource,
      stored.resourceIndex,
      ...statement.args,
    ],
  };
};

export const bindLegacyPaymentResource = async (
  payment: LegacyPaymentReplay,
  resource: ProviderSessionResource,
  observedAt = Date.now(),
): Promise<LegacyPaymentReplay> => {
  const update = await execute(
    `UPDATE payment_sessions SET provider = ?, updated_at = MAX(updated_at, ?),
        revision = revision + 1
      WHERE id = ? AND origin = 'legacy'
        AND (provider IS NULL OR provider = ?)
      RETURNING id`,
    [resource.provider, observedAt, payment.id, resource.provider],
  );
  if (resultRows<{ id: string }>(update).length !== 1) {
    throw new Error(
      `Legacy payment ${payment.id} cannot bind to ${resource.provider}`,
    );
  }
  await executeBatch([
    await legacyCaseStatement(
      payment.id,
      resource,
      {
        fact: "provider_session",
        legacyPaymentId: payment.id,
        providerRefundedAt: "",
        source:
          resource.provider === "sumup" ? "sumup_checkouts" : "checkout_stages",
      },
      (stored) => ({
        args: [observedAt, observedAt, stored.encryptedEvidence, observedAt],
        sql: `INSERT OR IGNORE INTO payment_cases
        (payment_id, resource, resource_index, reason, state, first_observed_at,
         last_observed_at, next_reconcile_at, consecutive_count, alerted_at,
         alerted_revision, evidence, revision, resolved_at)
        VALUES (?, ?, ?, 'legacy_provider_session', 'resolved', ?, ?, NULL, 1,
          NULL, NULL, ?, 1, ?)`,
      }),
    ),
  ]);
  const [bound] = await getLegacyPaymentsByIds([payment.id]);
  if (bound === undefined) {
    throw new Error(`Legacy payment ${payment.id} disappeared while binding`);
  }
  return bound;
};

const ambiguousStatement =
  (
    candidates: string[],
    resource: ProviderSessionResource,
    observedAt: number,
  ): ((payment: LegacyPaymentReplay) => Promise<SqlStatement>) =>
  (payment) =>
    legacyCaseStatement(
      payment.id,
      resource,
      {
        fact: "mapping",
        legacyPaymentIds: candidates,
        source: "callback",
      },
      (stored) => ({
        args: [observedAt, observedAt, observedAt, stored.encryptedEvidence],
        sql: `INSERT INTO payment_cases
        (payment_id, resource, resource_index, reason, state, first_observed_at,
         last_observed_at, next_reconcile_at, consecutive_count, alerted_at,
         alerted_revision, evidence, revision, resolved_at)
        VALUES (?, ?, ?, 'legacy_mapping_ambiguous', 'needs_action', ?, ?, NULL,
          1, ?, 1, ?, 1, NULL)
        ON CONFLICT(payment_id, resource_index) DO UPDATE SET
          reason = excluded.reason,
          state = 'needs_action',
          last_observed_at = excluded.last_observed_at,
          next_reconcile_at = NULL,
          consecutive_count = payment_cases.consecutive_count + 1,
          alerted_at = excluded.alerted_at,
          alerted_revision = payment_cases.revision + 1,
          evidence = excluded.evidence,
          revision = payment_cases.revision + 1,
          resolved_at = NULL`,
      }),
    );

export const recordLegacyMappingAmbiguity = async (
  payments: readonly LegacyPaymentReplay[],
  resource: ProviderSessionResource,
  observedAt = Date.now(),
): Promise<void> => {
  const candidateIds = payments.map((payment) => payment.id).sort();
  const statements = await mapParallel(
    ambiguousStatement(candidateIds, resource, observedAt),
  )([...payments]);
  await executeBatch(statements);
};

/** Attach the configured stable account facts without inventing payment facts. */
export const assignLegacyPaymentAccount = async (
  paymentId: string,
  account: PaymentAccount,
  assignedAt = Date.now(),
): Promise<void> => {
  const result = await execute(
    `UPDATE payment_sessions
        SET provider = ?, mode = ?, account_id = ?, updated_at = MAX(updated_at, ?),
            revision = revision + 1
      WHERE id = ? AND origin = 'legacy'
        AND (provider IS NULL OR provider = ?)
        AND (mode IS NULL OR mode = ?)
        AND (account_id IS NULL OR account_id = ?)`,
    [
      account.provider,
      account.mode,
      account.accountId,
      assignedAt,
      paymentId,
      account.provider,
      account.mode,
      account.accountId,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw new Error(`Legacy payment ${paymentId} cannot use this account`);
  }
};
