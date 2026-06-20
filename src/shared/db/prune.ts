/**
 * Database pruning — delete rows from tables that grow unboundedly
 * but whose contents are only useful for a short window.
 *
 * Tables pruned:
 * - processed_payments: idempotency ledger. Only needed while webhook retries
 *   could still arrive (Stripe/Square retry for up to ~3 days). Retention
 *   defaults to 90 days and is floored at WEBHOOK_RETRY_WINDOW_DAYS (enforced in
 *   limits.ts) so a row is never pruned while a retry could still re-process it.
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
 * - attendees (orphaned only): rows with no surviving listing booking, older
 *   than the age chosen on the Privacy page. Opt-in — only scheduled while
 *   `auto_purge_orphans` is on (see PRUNE_TASKS).
 *
 * The scheduler is fire-and-forget via `addPendingWork` from the request
 * handler. Each table has its own `last_pruned_*` timestamp; a table is
 * pruned only when PRUNE_INTERVAL_MS has elapsed since its last run.
 */

import { execute } from "#shared/db/client.ts";
import { purgeOrphanedAttendees } from "#shared/db/orphan-attendees.ts";
import { RESOLVED_OUTCOME } from "#shared/db/processed-payments.ts";
import { settings } from "#shared/db/settings.ts";
import {
  PRUNE_CONTACTS_RETENTION_MS,
  PRUNE_INTERVAL_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
  PRUNE_SUMUP_RETENTION_MS,
  PRUNE_TOKENS_RETENTION_MS,
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
  parsePositiveInt,
} from "#shared/limits.ts";
import { logDebug } from "#shared/logger.ts";
import { nowMs } from "#shared/now.ts";
import { orphanRetentionCutoffIso } from "#shared/orphan-retention.ts";

/**
 * Build a pruner that deletes rows older than `retentionMs`, binding an
 * ISO-timestamp cutoff to the single `?` placeholder in `sql`.
 */
const isoAgePruner =
  (sql: string, retentionMs: number) => async (): Promise<number> => {
    const cutoffIso = new Date(nowMs() - retentionMs).toISOString();
    const result = await execute(sql, [cutoffIso]);
    return result.rowsAffected;
  };

/**
 * Delete resolved processed_payments rows older than the retention window: both
 * finalized successes (attendee_id set) and recorded terminal failures
 * (failure_data set). By the time the window elapses no provider retry can
 * still arrive, so dropping the idempotency row is safe. Genuinely abandoned,
 * outcome-less reservations (attendee_id NULL and no failure_data) are left for
 * deleteAllStaleReservations in processed-payments.ts.
 */
export const prunePayments = isoAgePruner(
  `DELETE FROM processed_payments WHERE ${RESOLVED_OUTCOME} AND processed_at < ?`,
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

/** Delete unreferenced encrypted free-text strings older than retention. */
export const pruneUnusedStrings = isoAgePruner(
  "DELETE FROM strings WHERE used_count = 0 AND created < ?",
  PRUNE_UNUSED_STRINGS_RETENTION_MS,
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

/**
 * Parse a `last_pruned_*` setting (stored as ms-epoch string) to a number.
 * Empty string / unparseable => 0, meaning "never run, due immediately".
 */
const parseLastPrunedMs = (raw: string): number => parsePositiveInt(raw, 0);

/** True when now - last >= PRUNE_INTERVAL_MS. */
const isDue = (lastMs: number, now: number): boolean =>
  now - lastMs >= PRUNE_INTERVAL_MS;

type PruneTask = {
  name: string;
  lastRaw: string;
  writeLast: (value: string) => Promise<void>;
  run: () => Promise<number>;
};

const PRUNE_TASKS = (): PruneTask[] => [
  {
    lastRaw: settings.lastPrunedPayments,
    name: "processed_payments",
    run: prunePayments,
    writeLast: settings.update.lastPrunedPayments,
  },
  {
    lastRaw: settings.lastPrunedSumup,
    name: "sumup_checkouts",
    run: pruneSumupCheckouts,
    writeLast: settings.update.lastPrunedSumup,
  },
  {
    lastRaw: settings.lastPrunedStrings,
    name: "strings",
    run: pruneUnusedStrings,
    writeLast: settings.update.lastPrunedStrings,
  },
  {
    lastRaw: settings.lastPrunedSessions,
    name: "sessions",
    run: pruneSessions,
    writeLast: settings.update.lastPrunedSessions,
  },
  {
    lastRaw: settings.lastPrunedLogins,
    name: "login_attempts",
    run: pruneLoginAttempts,
    writeLast: settings.update.lastPrunedLogins,
  },
  {
    lastRaw: settings.lastPrunedTokens,
    name: "token_attempts",
    run: pruneTokenAttempts,
    writeLast: settings.update.lastPrunedTokens,
  },
  {
    lastRaw: settings.lastPrunedContacts,
    name: "contact_preferences",
    run: pruneContacts,
    writeLast: settings.update.lastPrunedContacts,
  },
  // Opt-in: scheduled only while the owner leaves automatic orphan purging on.
  ...(settings.autoPurgeOrphans
    ? [
        {
          lastRaw: settings.lastPrunedOrphans,
          name: "orphan_attendees",
          run: pruneOrphanAttendees,
          writeLast: settings.update.lastPrunedOrphans,
        },
      ]
    : []),
];

/**
 * Run one prune task: write the timestamp first (claims the slot so concurrent
 * requests don't double-run), then delete. Errors are caught and logged so
 * one failing task can't block the others or surface to the user.
 */
const runTask = async (task: PruneTask, now: number): Promise<void> => {
  try {
    await task.writeLast(String(now));
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
    isDue(parseLastPrunedMs(t.lastRaw), now),
  );
  if (due.length === 0) return;
  await Promise.all(due.map((t) => runTask(t, now)));
};
