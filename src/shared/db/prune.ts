/** Fixed-size database pruning used by the maintenance task and owner actions. */

import * as v from "valibot";
import { decrypt } from "#shared/crypto/encryption.ts";
import { addressCachePruneStatement } from "#shared/db/address-cache.ts";
import { attendeeDependentDeleteStatements } from "#shared/db/attendees/delete.ts";
import {
  executeBatchWithResults,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { paymentSessionAttendeeChangeStatement } from "#shared/db/payments/attendee.ts";
import { redactPaymentHistoryPage } from "#shared/db/payments/redaction.ts";
import type { PaymentHistoryRedactionCheckpoint } from "#shared/db/payments/redaction-page.ts";
import { settings } from "#shared/db/settings.ts";
import {
  MAINTENANCE_PRUNE_BATCH,
  PAYMENT_HISTORY_REDACTION_MS,
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
} from "#shared/limits.ts";
import { logDebug } from "#shared/logger.ts";
import { now, nowMs } from "#shared/now.ts";
import { orphanRetentionCutoffIso } from "#shared/orphan-retention.ts";
import type { User } from "#shared/types.ts";

type PruneStatement = SqlStatement;

export interface DatabasePruningResult {
  checkpoint: string | null;
  fullBatch: boolean;
}

const boundedDelete = (
  table: string,
  where: string,
  args: (number | string)[],
): PruneStatement => ({
  args: [...args, MAINTENANCE_PRUNE_BATCH],
  sql: `DELETE FROM ${table}
         WHERE rowid IN (
           SELECT rowid FROM ${table} WHERE ${where}
           ORDER BY rowid LIMIT ?
         )`,
});

const isoCutoff = (retentionMs: number): string =>
  new Date(nowMs() - retentionMs).toISOString();

const pruneStatements = (): PruneStatement[] => [
  boundedDelete("strings", "used_count = 0 AND created < ?", [
    isoCutoff(PRUNE_UNUSED_STRINGS_RETENTION_MS),
  ]),
  addressCachePruneStatement(),
  boundedDelete("sessions", "expires < ?", [
    nowMs() - PRUNE_SESSIONS_RETENTION_MS,
  ]),
  boundedDelete(
    "login_attempts",
    "locked_until IS NOT NULL AND locked_until < ?",
    [nowMs() - PRUNE_LOGINS_RETENTION_MS],
  ),
  boundedDelete("token_attempts", "last_attempt < ?", [
    nowMs() - PRUNE_TOKENS_RETENTION_MS,
  ]),
  boundedDelete(
    "contact_preferences",
    "unsubscribed = 0 AND last_activity < ?",
    [nowMs() - PRUNE_CONTACTS_RETENTION_MS],
  ),
];

const ORPHAN_IDS = `SELECT attendee.id
  FROM attendees AS attendee
 WHERE attendee.created < ?
   AND NOT EXISTS (
     SELECT 1 FROM listing_attendees AS booking
      WHERE booking.attendee_id = attendee.id
   )
 ORDER BY attendee.id LIMIT ?`;

const orphanStatements = (): PruneStatement[] => {
  if (!settings.autoPurgeOrphans) return [];
  const args = [
    orphanRetentionCutoffIso(settings.orphanPurgeRetention, nowMs()),
    MAINTENANCE_PRUNE_BATCH,
  ];
  return [
    paymentSessionAttendeeChangeStatement({ args, sql: ORPHAN_IDS }, null),
    ...attendeeDependentDeleteStatements({ args, sql: ORPHAN_IDS }),
    {
      args,
      sql: `DELETE FROM attendees WHERE id IN (${ORPHAN_IDS})`,
    },
  ];
};

type InviteCandidate = Pick<User, "id" | "invite_expiry">;

type InvitePage = {
  checkpoint: number | null;
  expiredIds: number[];
  hasMore: boolean;
};

interface PruningCheckpoint extends PaymentHistoryRedactionCheckpoint {
  inviteId: number | null;
}

const EMPTY_CHECKPOINT: PruningCheckpoint = {
  caseId: null,
  inviteId: null,
  sessionId: null,
  sessionUpdatedAt: null,
};

const pruningNumberSchema = (minimum: number) =>
  v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(minimum)));

const PruningIdSchema = pruningNumberSchema(1);

const PruningCheckpointSchema = v.pipe(
  v.strictObject({
    caseId: PruningIdSchema,
    inviteId: PruningIdSchema,
    sessionId: v.nullable(v.string()),
    sessionUpdatedAt: pruningNumberSchema(0),
  }),
  v.check(
    (checkpoint) =>
      (checkpoint.sessionId === null) ===
      (checkpoint.sessionUpdatedAt === null),
    "Payment pruning checkpoint fields must be stored together",
  ),
);

const parseCheckpoint = (checkpoint: string | null): PruningCheckpoint => {
  if (checkpoint === null) return EMPTY_CHECKPOINT;
  const oldInviteId = Number(checkpoint);
  if (Number.isSafeInteger(oldInviteId) && oldInviteId >= 1) {
    return { ...EMPTY_CHECKPOINT, inviteId: oldInviteId };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpoint);
  } catch {
    throw new Error(`Invalid database pruning checkpoint: ${checkpoint}`);
  }
  const result = v.safeParse(PruningCheckpointSchema, parsed);
  if (!result.success) {
    throw new Error(`Invalid database pruning checkpoint: ${checkpoint}`);
  }
  return result.output;
};

const storeCheckpoint = (checkpoint: PruningCheckpoint): string | null => {
  if (
    checkpoint.caseId === null &&
    checkpoint.sessionId === null &&
    checkpoint.inviteId !== null
  ) {
    return String(checkpoint.inviteId);
  }
  return Object.values(checkpoint).every((value) => value === null)
    ? null
    : JSON.stringify(checkpoint);
};

const expiredInvitePage = async (
  checkpoint: number | null,
): Promise<InvitePage> => {
  const rows = await queryAll<InviteCandidate>(
    `SELECT id, invite_expiry FROM users
      WHERE wrapped_data_key IS NULL
        AND password_hash = ''
        AND invite_expiry IS NOT NULL
        AND (? IS NULL OR id > ?)
      ORDER BY id
      LIMIT ?`,
    [checkpoint, checkpoint, MAINTENANCE_PRUNE_BATCH + 1],
  );
  const candidates = rows.slice(0, MAINTENANCE_PRUNE_BATCH);
  const cutoff = now().getTime();
  const inviteStates = await Promise.all(
    candidates.map(async (row) => ({
      expired: new Date(await decrypt(row.invite_expiry!)).getTime() < cutoff,
      id: row.id,
    })),
  );
  const hasMore = rows.length > MAINTENANCE_PRUNE_BATCH;
  return {
    checkpoint: hasMore ? candidates[candidates.length - 1]!.id : null,
    expiredIds: inviteStates
      .filter(({ expired }) => expired)
      .map(({ id }) => id),
    hasMore,
  };
};

const inviteStatements = (ids: number[]): PruneStatement[] => {
  if (ids.length === 0) return [];
  const inIds = ids.map(() => "?").join(", ");
  const unactivatedIds = `SELECT id FROM users
    WHERE id IN (${inIds})
      AND wrapped_data_key IS NULL
      AND password_hash = ''
      AND invite_expiry IS NOT NULL`;
  return [
    { field: "user_id", table: "api_keys" },
    { field: "user_id", table: "sessions" },
    { field: "user_id", table: "user_logistics_agents" },
    { field: "id", table: "users" },
  ].map(({ field, table }) => ({
    args: ids,
    sql: `DELETE FROM ${table} WHERE ${field} IN (${unactivatedIds})`,
  }));
};

const lastResultIndexes = (batches: PruneStatement[][]): number[] =>
  batches.reduce((indexes, batch) => {
    const previous = indexes[indexes.length - 1] ?? -1;
    indexes.push(previous + batch.length);
    return indexes;
  }, [] as number[]);

export const runDatabasePruning = async (
  checkpoint: string | null = null,
): Promise<DatabasePruningResult> => {
  const saved = parseCheckpoint(checkpoint);
  const invitePage = await expiredInvitePage(saved.inviteId);
  const paymentPage = await redactPaymentHistoryPage(
    saved,
    nowMs() - PAYMENT_HISTORY_REDACTION_MS,
  );
  const batches = [
    ...pruneStatements().map((statement) => [statement]),
    orphanStatements(),
    inviteStatements(invitePage.expiredIds),
  ].filter((batch) => batch.length > 0);
  const results = await executeBatchWithResults(batches.flat());
  const fullBatch =
    invitePage.hasMore ||
    paymentPage.followUp ||
    lastResultIndexes(batches).some(
      (index) => results[index]!.rowsAffected === MAINTENANCE_PRUNE_BATCH,
    );
  const deleted = results.reduce(
    (total, result) => total + result.rowsAffected,
    0,
  );
  if (deleted > 0) logDebug("Prune", `deleted ${deleted} expired rows`);
  if (paymentPage.redacted > 0) {
    logDebug("Prune", `redacted ${paymentPage.redacted} payment rows`);
  }
  return {
    checkpoint: storeCheckpoint({
      ...paymentPage.checkpoint,
      inviteId: invitePage.checkpoint,
    }),
    fullBatch,
  };
};
