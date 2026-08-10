/** Fixed-size database pruning used by the maintenance task and owner actions. */

import { decrypt } from "#shared/crypto/encryption.ts";
import { addressCachePruneStatement } from "#shared/db/address-cache.ts";
import { attendeeDependentDeleteStatements } from "#shared/db/attendees/delete.ts";
import {
  executeBatchWithResults,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { orphanIdsBatch } from "#shared/db/orphan-attendees.ts";
import { settings } from "#shared/db/settings.ts";
import {
  MAINTENANCE_PRUNE_BATCH,
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
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

const paymentStatement = (): PruneStatement => ({
  args: [isoCutoff(PRUNE_PAYMENTS_RETENTION_MS), MAINTENANCE_PRUNE_BATCH],
  sql: `DELETE FROM processed_payments
         WHERE rowid IN (
           SELECT payment.rowid
             FROM processed_payments AS payment
            WHERE payment.processed_at < ?
              -- A row with refund work on it is never pruned, however old it
              -- is, and however long ago the claim was taken. The retention
              -- window is measured from checkout, so a years-old booking
              -- refunded this morning is already past it — and a claim that
              -- outlives its run is exactly the case worth keeping: a keyless
              -- refund whose answer was lost holds on deliberately, because
              -- the row is the only record that money may already be on its
              -- way back. Deleting it would take the reference index and the
              -- returned-money marker with it, leaving a retry to send the
              -- same payout again.
              --
              -- Keeping it strands nothing: a stale claim is resumable, so the
              -- next run for that attendee picks the row up and settles it.
              -- This is the one reader that cannot decrypt, so it routes on
              -- the mirror.
              AND payment.protected_state = ''
              AND (
                payment.failure_data != ''
                OR (
                  payment.attendee_id IS NOT NULL
                  AND (
                    payment.payment_reference = ''
                    OR NOT EXISTS (
                      SELECT 1 FROM attendees AS attendee
                       WHERE attendee.id = payment.attendee_id
                    )
                    OR EXISTS (
                      SELECT 1 FROM transfers AS transfer
                       WHERE transfer.kind = 'refund_cash'
                         AND transfer.source_type = 'attendee'
                         AND transfer.source_id = CAST(payment.attendee_id AS TEXT)
                    )
                  )
                )
              )
            ORDER BY payment.rowid LIMIT ?
         )`,
});

const pruneStatements = (): PruneStatement[] => [
  paymentStatement(),
  boundedDelete("sumup_checkouts", "created_at < ?", [
    isoCutoff(PRUNE_SUMUP_RETENTION_MS),
  ]),
  boundedDelete("strings", "used_count = 0 AND created < ?", [
    isoCutoff(PRUNE_UNUSED_STRINGS_RETENTION_MS),
  ]),
  addressCachePruneStatement(),
  boundedDelete("sessions", "expires < ?", [
    nowMs() - PRUNE_SESSIONS_RETENTION_MS,
  ]),
  // Both arms compare against the same cutoff, bound once as ?1; the builder's
  // unnumbered LIMIT ? continues after the highest number, so it reads ?2.
  boundedDelete(
    "login_attempts",
    `(locked_until IS NOT NULL AND locked_until < ?1)
        OR (locked_until IS NULL AND last_attempt < ?1)`,
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

const orphanStatements = (): PruneStatement[] => {
  if (!settings.autoPurgeOrphans) return [];
  const args = [
    orphanRetentionCutoffIso(settings.orphanPurgeRetention, nowMs()),
    MAINTENANCE_PRUNE_BATCH,
  ];
  return [
    ...attendeeDependentDeleteStatements({ args, sql: orphanIdsBatch() }),
    {
      args,
      sql: `DELETE FROM attendees WHERE id IN (${orphanIdsBatch()})`,
    },
  ];
};

type InviteCandidate = Pick<User, "id" | "invite_expiry">;

type InvitePage = {
  checkpoint: string | null;
  expiredIds: number[];
  hasMore: boolean;
};

const checkpointId = (checkpoint: string | null): number | null => {
  if (checkpoint === null) return null;
  const id = Number(checkpoint);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`Invalid invite pruning checkpoint: ${checkpoint}`);
  }
  return id;
};

const expiredInvitePage = async (
  checkpoint: string | null,
): Promise<InvitePage> => {
  const rows = await queryAll<InviteCandidate>(
    `SELECT id, invite_expiry FROM users
      WHERE wrapped_data_key IS NULL
        AND password_hash = ''
        AND invite_expiry IS NOT NULL
        AND (? IS NULL OR id > ?)
      ORDER BY id
      LIMIT ?`,
    [
      checkpointId(checkpoint),
      checkpointId(checkpoint),
      MAINTENANCE_PRUNE_BATCH + 1,
    ],
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
    checkpoint: hasMore ? String(candidates[candidates.length - 1]!.id) : null,
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
  const invitePage = await expiredInvitePage(checkpoint);
  const batches = [
    ...pruneStatements().map((statement) => [statement]),
    orphanStatements(),
    inviteStatements(invitePage.expiredIds),
  ].filter((batch) => batch.length > 0);
  const results = await executeBatchWithResults(batches.flat());
  const fullBatch =
    invitePage.hasMore ||
    lastResultIndexes(batches).some(
      (index) => results[index]!.rowsAffected === MAINTENANCE_PRUNE_BATCH,
    );
  const deleted = results.reduce(
    (total, result) => total + result.rowsAffected,
    0,
  );
  if (deleted > 0) logDebug("Prune", `deleted ${deleted} expired rows`);
  return { checkpoint: invitePage.checkpoint, fullBatch };
};
