/**
 * Database pruning — delete rows from tables that grow unboundedly
 * but whose contents are only useful for a short window.
 *
 * Tables pruned:
 * - processed_payments: payment-session replay records. Failed rows and rows
 *   that no longer hold a useful refund reference are pruned after the retry
 *   window; unrefunded attendees keep their stored charge references.
 * - sessions: once expires < now, the row is dead. Small grace window so
 *   expired-but-present sessions have a recognisable identity briefly.
 * - login_attempts: rows with an expired lockout are dead. (Rows with NULL
 *   locked_until are left alone: they represent in-progress attempt counts
 *   and have no timestamp we can key off.)
 * - contact_preferences: opaque per-contact recognition/contact-history rows.
 *   `last_activity` is bumped on booking and outreach; pruning subscribed rows
 *   bounds table growth and makes returning-customer recognition
 *   recency-bounded. Unsubscribed rows are suppression records and are kept.
 * - strings: owner-key-encrypted free-text answer values. The attendee_answers
 *   triggers maintain each row's reference count but never delete (a pending
 *   paid checkout can hold a `string_id` in its metadata before finalizing), so
 *   this age-based prune is the sole cleanup for unused rows.
 * - address_cache: encrypted address-lookup results. Reads already ignore rows
 *   older than ADDRESS_CACHE_DAYS, so this prune just reclaims the storage.
 * - attendees (orphaned only): rows with no surviving listing booking, older
 *   than the age chosen on the Privacy page. Opt-in — only scheduled while
 *   `auto_purge_orphans` is on (see PRUNE_TASKS).
 * - users (expired invites only): un-activated invited users whose invite has
 *   expired. Removing the row drops its invite_wrapped_data_key handoff — a
 *   DATA_KEY wrapped under the emailed invite code — so an intercepted but
 *   expired invite link can no longer unwrap it from a database dump.
 *
 * The scheduler is fire-and-forget via `addPendingWork` from the request
 * handler. Each table has its own `last_pruned_*` timestamp; a table is
 * pruned only when PRUNE_INTERVAL_MS has elapsed since its last run.
 */

import { execute } from "#shared/db/client.ts";
import { purgeOrphanedAttendees } from "#shared/db/orphan-attendees.ts";
import { writeRawBatch } from "#shared/db/settings/raw-writes.ts";
import { setSnapshotField } from "#shared/db/settings/snapshot.ts";
import { settings } from "#shared/db/settings.ts";
import { pruneExpiredInvites } from "#shared/db/users.ts";
import { taskIsDue } from "#shared/interval-gate.ts";
import {
  ADDRESS_CACHE_MS,
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_INTERVAL_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
} from "#shared/limits.ts";
import { logDebug } from "#shared/logger.ts";
import { isoBefore, nowMs } from "#shared/now.ts";
import { orphanRetentionCutoffIso } from "#shared/orphan-retention.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { pruneAbandonedCheckoutStages } from "#shared/staged-checkout.ts";

/**
 * Build a pruner that deletes rows older than `retentionMs`, binding an
 * ISO-timestamp cutoff to the single `?` placeholder in `sql`.
 */
const isoAgePruner =
  (sql: string, retentionMs: number) => async (): Promise<number> => {
    const cutoffIso = isoBefore(retentionMs);
    const result = await execute(sql, [cutoffIso]);
    return result.rowsAffected;
  };

/**
 * Delete old processed_payments rows only when they cannot help a future admin
 * refund: terminal failures, finalized rows with no stored charge reference,
 * rows whose attendee is gone, and rows whose attendee already has refund_cash in
 * the ledger. Unresolved reservations stay for deleteAllStaleReservations.
 */
export const prunePayments = isoAgePruner(
  `DELETE FROM processed_payments AS payment
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
      )`,
  PRUNE_PAYMENTS_RETENTION_MS,
);

/**
 * Delete SumUp checkout staging rows older than their (short) retention.
 * The row carries encrypted PII and is only needed between checkout creation
 * and payment completion — SumUp checkouts expire after 30 minutes and
 * webhook retries stop after 2 hours, so 24h retention is already generous.
 */
export const pruneSumupCheckouts = isoAgePruner(
  "DELETE FROM sumup_checkouts WHERE created_at < ?",
  PRUNE_SUMUP_RETENTION_MS,
);

const pruneCheckoutStorage = async (): Promise<number> =>
  (await pruneSumupCheckouts()) + (await pruneAbandonedCheckoutStages());

/** Delete unreferenced encrypted free-text strings older than retention. */
export const pruneUnusedStrings = isoAgePruner(
  "DELETE FROM strings WHERE used_count = 0 AND created < ?",
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
);

/** Delete cached address-lookup results older than ADDRESS_CACHE_DAYS.
 * Reads in address-cache.ts filter on the same cutoff, so this prune is pure
 * housekeeping — an expired row is already unservable before it is deleted. */
export const pruneAddressCache = isoAgePruner(
  "DELETE FROM address_cache WHERE created < ?",
  ADDRESS_CACHE_MS,
);

/**
 * Delete sessions whose `expires` is older than (now - retention window).
 * Uses millisecond-epoch numeric comparison (same format as the column).
 */
export const pruneSessions = async (): Promise<number> => {
  const cutoffMs = nowMs() - PRUNE_SESSIONS_RETENTION_MS;
  const result = await execute("DELETE FROM sessions WHERE expires < ?", [
    cutoffMs,
  ]);
  return result.rowsAffected;
};

/**
 * Delete login_attempts rows whose lockout expired more than the retention
 * window ago. Rows with NULL `locked_until` have no timestamp and are left
 * alone (they will be overwritten on the next attempt from that IP).
 */
export const pruneLoginAttempts = async (): Promise<number> => {
  const cutoffMs = nowMs() - PRUNE_LOGINS_RETENTION_MS;
  const result = await execute(
    "DELETE FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until < ?",
    [cutoffMs],
  );
  return result.rowsAffected;
};

/**
 * Delete token_attempts rows untouched for longer than the retention window.
 * `last_attempt` is set on every failure record, so this covers both
 * expired-lockout rows and stale counter-only rows.
 */
export const pruneTokenAttempts = async (): Promise<number> => {
  const cutoffMs = nowMs() - PRUNE_TOKENS_RETENTION_MS;
  const result = await execute(
    "DELETE FROM token_attempts WHERE last_attempt < ?",
    [cutoffMs],
  );
  return result.rowsAffected;
};

/** Delete subscribed contact-preference rows untouched beyond retention. */
export const pruneContacts = async (): Promise<number> => {
  const cutoffMs = nowMs() - PRUNE_CONTACTS_RETENTION_MS;
  const result = await execute(
    "DELETE FROM contact_preferences WHERE unsubscribed = 0 AND last_activity < ?",
    [cutoffMs],
  );
  return result.rowsAffected;
};

/**
 * Delete orphaned attendees (no surviving listing booking) older than the
 * owner-configured age. Unlike the other tasks this is opt-in: it is only added
 * to the schedule while `auto_purge_orphans` is on, and the age comes from the
 * Privacy page rather than a fixed constant.
 */
export const pruneOrphanAttendees = (): Promise<number> =>
  purgeOrphanedAttendees(
    orphanRetentionCutoffIso(settings.orphanPurgeRetention, nowMs()),
  );

type PruneTask = {
  field: Parameters<typeof setSnapshotField>[0];
  key: string;
  name: string;
  lastRaw: string;
  run: () => Promise<number>;
};

const PRUNE_TASKS = (): PruneTask[] => [
  {
    field: "last_pruned_payments",
    key: CONFIG_KEYS.LAST_PRUNED_PAYMENTS,
    lastRaw: settings.lastPrunedPayments,
    name: "processed_payments",
    run: prunePayments,
  },
  {
    field: "last_pruned_sumup",
    key: CONFIG_KEYS.LAST_PRUNED_SUMUP,
    lastRaw: settings.lastPrunedSumup,
    name: "checkout_storage",
    run: pruneCheckoutStorage,
  },
  {
    field: "last_pruned_strings",
    key: CONFIG_KEYS.LAST_PRUNED_STRINGS,
    lastRaw: settings.lastPrunedStrings,
    name: "strings",
    run: pruneUnusedStrings,
  },
  {
    field: "last_pruned_sessions",
    key: CONFIG_KEYS.LAST_PRUNED_SESSIONS,
    lastRaw: settings.lastPrunedSessions,
    name: "sessions",
    run: pruneSessions,
  },
  {
    field: "last_pruned_logins",
    key: CONFIG_KEYS.LAST_PRUNED_LOGINS,
    lastRaw: settings.lastPrunedLogins,
    name: "login_attempts",
    run: pruneLoginAttempts,
  },
  {
    field: "last_pruned_tokens",
    key: CONFIG_KEYS.LAST_PRUNED_TOKENS,
    lastRaw: settings.lastPrunedTokens,
    name: "token_attempts",
    run: pruneTokenAttempts,
  },
  {
    field: "last_pruned_contacts",
    key: CONFIG_KEYS.LAST_PRUNED_CONTACTS,
    lastRaw: settings.lastPrunedContacts,
    name: "contact_preferences",
    run: pruneContacts,
  },
  {
    field: "last_pruned_addresses",
    key: CONFIG_KEYS.LAST_PRUNED_ADDRESSES,
    lastRaw: settings.lastPrunedAddresses,
    name: "address_cache",
    run: pruneAddressCache,
  },
  {
    field: "last_pruned_invites",
    key: CONFIG_KEYS.LAST_PRUNED_INVITES,
    lastRaw: settings.lastPrunedInvites,
    name: "expired_invites",
    run: pruneExpiredInvites,
  },
  // Opt-in: scheduled only while the owner leaves automatic orphan purging on.
  ...(settings.autoPurgeOrphans
    ? [
        {
          field: "last_pruned_orphans" as const,
          key: CONFIG_KEYS.LAST_PRUNED_ORPHANS,
          lastRaw: settings.lastPrunedOrphans,
          name: "orphan_attendees",
          run: pruneOrphanAttendees,
        },
      ]
    : []),
];

/**
 * Run one prune task: write the timestamp first (claims the slot so concurrent
 * requests don't double-run), then delete. Errors are caught and logged so
 * one failing task can't block the others or surface to the user.
 */
const runTask = async (task: PruneTask): Promise<void> => {
  try {
    const deleted = await task.run();
    if (deleted > 0) {
      logDebug("Prune", `${task.name}: deleted ${deleted} rows`);
    }
  } catch (e) {
    logDebug("Prune", `${task.name} failed: ${String(e)}`);
  }
};

/**
 * Run all prune tasks that are due. Safe to call from a fire-and-forget
 * context (addPendingWork). Never throws.
 */
export const maybeRunPrunes = async (): Promise<void> => {
  const now = nowMs();
  const due = PRUNE_TASKS().filter((t) =>
    taskIsDue(t.lastRaw, PRUNE_INTERVAL_MS, now),
  );
  if (due.length === 0) return;
  const value = String(now);
  try {
    await writeRawBatch(due.map((task) => [task.key, value] as const));
  } catch (error) {
    logDebug("Prune", `marker batch failed: ${String(error)}`);
    return;
  }
  for (const task of due) setSnapshotField(task.field, value);
  await Promise.all(due.map(runTask));
};
