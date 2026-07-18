/** Fixed-size database pruning used by the maintenance task and owner actions. */

import { decrypt } from "#shared/crypto/encryption.ts";
import { attendeeDependentDeleteStatements } from "#shared/db/attendees/delete.ts";
import {
  executeBatchWithResults,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  ADDRESS_CACHE_MS,
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
  boundedDelete("address_cache", "created < ?", [isoCutoff(ADDRESS_CACHE_MS)]),
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
    ...attendeeDependentDeleteStatements({ args, sql: ORPHAN_IDS }),
    {
      args,
      sql: `DELETE FROM attendees WHERE id IN (${ORPHAN_IDS})`,
    },
  ];
};

type InviteCandidate = Pick<User, "id" | "invite_expiry">;

const expiredInviteIds = async (): Promise<number[]> => {
  const rows = await queryAll<InviteCandidate>(
    `SELECT id, invite_expiry FROM users
      WHERE wrapped_data_key IS NULL
        AND password_hash = ''
        AND invite_expiry IS NOT NULL
      ORDER BY id LIMIT ?`,
    [MAINTENANCE_PRUNE_BATCH],
  );
  const cutoff = now().getTime();
  const expired: number[] = [];
  for (const row of rows) {
    const expiryMs = new Date(await decrypt(row.invite_expiry!)).getTime();
    if (expiryMs < cutoff) expired.push(row.id);
  }
  return expired;
};

const inviteStatements = (ids: number[]): PruneStatement[] => {
  if (ids.length === 0) return [];
  const inIds = ids.map(() => "?").join(", ");
  return [
    { field: "user_id", table: "api_keys" },
    { field: "user_id", table: "sessions" },
    { field: "user_id", table: "user_logistics_agents" },
    { field: "id", table: "users" },
  ].map(({ field, table }) => ({
    args: ids,
    sql: `DELETE FROM ${table} WHERE ${field} IN (${inIds})`,
  }));
};

export const runDatabasePruning = async (): Promise<void> => {
  const inviteIds = await expiredInviteIds();
  const statements = [
    ...pruneStatements(),
    ...orphanStatements(),
    ...inviteStatements(inviteIds),
  ];
  const results = await executeBatchWithResults(statements);
  const deleted = results.reduce(
    (total, result) => total + result.rowsAffected,
    0,
  );
  if (deleted > 0) logDebug("Prune", `deleted ${deleted} expired rows`);
};
