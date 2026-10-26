/** Fixed-size database pruning used by the maintenance task and owner actions. */

import { decrypt } from "#crypto/encryption.ts";
import { addressCachePruneStatement } from "#db/address-cache.ts";
import { attendeeRemovalStatements } from "#db/attendees/delete.ts";
import {
  executeBatchWithResults,
  inPlaceholders,
  queryAll,
  type SqlStatement,
} from "#db/client.ts";
import {
  numberedStatement,
  type SqlParameter,
} from "#db/numbered-statement.ts";
import { orphanIdsBatch } from "#db/orphan-attendees.ts";
import { PRUNE_SCAN_OPERATIONS_RETENTION_MS } from "#db/processed-scan-operations.ts";
import { settings } from "#db/settings.ts";
import {
  refundAuthorityPrunableSql,
  refundAuthorityWorkSql,
} from "#payment/refund-authority-lifecycle.ts";
import { RECOVERY_PRUNABLE_NODES } from "#payment/sumup-recovery-machine-spec.ts";
import {
  MAINTENANCE_PRUNE_BATCH,
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
  WEBHOOK_RETRY_WINDOW_DAYS,
} from "#shared/limits.ts";
import { logDebug } from "#shared/logger.ts";
import { DAY_MS, isoBefore, now, nowMs } from "#shared/now.ts";
import { orphanRetentionCutoffIso } from "#shared/orphan-retention.ts";
import { SQUARE_LINK_RETENTION_MS } from "#shared/square/limits.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";
import type { User } from "#types";

type PruneStatement = SqlStatement;

export interface DatabasePruningResult {
  checkpoint: string | null;
  fullBatch: boolean;
}

const boundedDelete = (
  table: string,
  buildWhere: (bind: SqlParameter) => string,
): PruneStatement =>
  numberedStatement((bind) => {
    const batch = bind(MAINTENANCE_PRUNE_BATCH);
    return `DELETE FROM ${table}
         WHERE rowid IN (
           SELECT rowid FROM ${table} WHERE ${buildWhere(bind)}
           ORDER BY rowid LIMIT ${batch}
         )`;
  });

const paymentStatement = (): PruneStatement => ({
  args: [isoBefore(PRUNE_PAYMENTS_RETENTION_MS), MAINTENANCE_PRUNE_BATCH],
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
              -- Keeping it strands nothing: a refund run's stale claim is
              -- resumable by the next run for that attendee, and a stored
              -- placeholder's held work is finished by webhook redelivery or
              -- the attendee page's refresh route.
              -- This reader cannot decrypt, so it routes on the mirrors.
              AND payment.protected_state = ''
              AND NOT EXISTS (
                SELECT 1 FROM attendees AS attendee
                 WHERE attendee.id = payment.attendee_id
                   AND attendee.pii_payment_session_id = payment.payment_session_id
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM payment_charges AS charge
                 WHERE charge.reference_index = payment.payment_reference_index
                   AND ${refundAuthorityWorkSql("charge.")}
              )
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
                      SELECT 1 FROM payment_charges AS charge
                       WHERE charge.reference_index = payment.payment_reference_index
                         AND ${refundAuthorityPrunableSql("charge.")}
                    )
                  )
                )
              )
            ORDER BY payment.rowid LIMIT ?
         )`,
});

const pruneStatements = (): PruneStatement[] => [
  paymentStatement(),
  // Only the rows the machine says may go. A checkout that may be holding
  // money nobody has accounted for is kept however old it gets — deleting it
  // is the exact harm the recovery task exists to prevent.
  boundedDelete(
    "sumup_checkouts",
    (bind) =>
      `created_at < ${bind(isoBefore(PRUNE_SUMUP_RETENTION_MS))} AND recovery_state IN (${RECOVERY_PRUNABLE_NODES.map((node) => bind(node)).join(", ")})`,
  ),
  // The payments cutoff keeps answers past the short SumUp staging window. A
  // Square row also waits for its link to end, and only an observed end
  // counts: its handle row must be gone. The fallback arm serves a site with
  // no scheduled monitor — past Square's own page lifetime plus the webhook
  // window, the link cannot take payment, so the answers go even though the
  // handle row remains. A payment made just before the end can still arrive
  // through webhook retries.
  boundedDelete("checkout_pending_answers", (bind) => {
    const paymentsCutoff = bind(isoBefore(PRUNE_PAYMENTS_RETENTION_MS));
    const squareCutoff = bind(isoBefore(SQUARE_LINK_RETENTION_MS));
    const webhookCutoff = bind(isoBefore(WEBHOOK_RETRY_WINDOW_DAYS * DAY_MS));
    return `created_at < ${paymentsCutoff}
       AND (
         link_ends_at IS NULL
         OR created_at < ${squareCutoff}
         OR (
           link_ends_at < ${webhookCutoff}
           AND NOT EXISTS (
             SELECT 1 FROM square_link_ends AS handle
              WHERE handle.session_index = checkout_pending_answers.session_index
           )
         )
       )`;
  }),
  // A Square link stops taking payment at Square's native lifetime (180 days)
  // at the latest, whatever the expiry task did, so a handle row older than
  // that bound plus the webhook window can hold nothing worth ending. Younger
  // rows keep their place until the task observes their end.
  boundedDelete(
    "square_link_ends",
    (bind) => `created_at < ${bind(isoBefore(SQUARE_LINK_RETENTION_MS))}`,
  ),
  boundedDelete(
    "strings",
    (bind) =>
      `used_count = 0 AND created < ${bind(isoBefore(PRUNE_UNUSED_STRINGS_RETENTION_MS))}`,
  ),
  addressCachePruneStatement(),
  boundedDelete(
    "sessions",
    (bind) => `expires < ${bind(nowMs() - PRUNE_SESSIONS_RETENTION_MS)}`,
  ),
  // Both arms compare against the same cutoff, so one bound value reads the
  // same token twice.
  boundedDelete("login_attempts", (bind) => {
    const cutoff = bind(nowMs() - PRUNE_LOGINS_RETENTION_MS);
    return `(locked_until IS NOT NULL AND locked_until < ${cutoff})
        OR (locked_until IS NULL AND last_attempt < ${cutoff})`;
  }),
  boundedDelete(
    "token_attempts",
    (bind) => `last_attempt < ${bind(nowMs() - PRUNE_TOKENS_RETENTION_MS)}`,
  ),
  boundedDelete(
    "contact_preferences",
    (bind) =>
      `unsubscribed = 0 AND last_activity < ${bind(nowMs() - PRUNE_CONTACTS_RETENTION_MS)}`,
  ),
  // A replay ledger row guards one offline delivery's retry, and a device
  // only retries while its saved cache is valid. Past the retention window
  // no retry can still admit, so the row — and the digest it holds — goes.
  boundedDelete(
    "processed_scan_operations",
    (bind) =>
      `created < ${bind(isoBefore(PRUNE_SCAN_OPERATIONS_RETENTION_MS))}`,
  ),
];

const orphanStatements = (): PruneStatement[] => {
  if (!settings.autoPurgeOrphans) return [];
  const args = [
    orphanRetentionCutoffIso(settings.orphanPurgeRetention, nowMs()),
    MAINTENANCE_PRUNE_BATCH,
  ];
  return [
    ...attendeeRemovalStatements({ args, sql: orphanIdsBatch() }),
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
  if (!isPositiveSafeInteger(id)) {
    throw new Error(`Invalid invite pruning checkpoint: ${checkpoint}`);
  }
  return id;
};

const expiredInvitePage = async (
  checkpoint: string | null,
): Promise<InvitePage> => {
  const { sql, args } = numberedStatement((bind) => {
    const position = bind(checkpointId(checkpoint));
    return `SELECT id, invite_expiry FROM users
      WHERE wrapped_data_key IS NULL
        AND password_hash = ''
        AND invite_expiry IS NOT NULL
        AND (${position} IS NULL OR id > ${position})
      ORDER BY id
      LIMIT ${bind(MAINTENANCE_PRUNE_BATCH + 1)}`;
  });
  // Both arms compare against the same saved position, so one bound value
  // reads the same token twice.
  const rows = await queryAll<InviteCandidate>(sql, args);
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
  const inIds = inPlaceholders(ids);
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
