/**
 * Database pruning — delete rows from tables that grow unboundedly
 * but whose contents are only useful for a short window.
 *
 * Tables pruned:
 * - processed_payments: idempotency ledger. Only needed while webhook
 *   retries could still arrive (Stripe retries for ~3 days). Defaults to 7 days.
 * - sessions: once expires < now, the row is dead. Small grace window so
 *   expired-but-present sessions have a recognisable identity briefly.
 * - login_attempts: rows with an expired lockout are dead. (Rows with NULL
 *   locked_until are left alone: they represent in-progress attempt counts
 *   and have no timestamp we can key off.)
 *
 * The scheduler is fire-and-forget via `addPendingWork` from the request
 * handler. Each table has its own `last_pruned_*` timestamp; a table is
 * pruned only when PRUNE_INTERVAL_MS has elapsed since its last run.
 */

import { getDb } from "#lib/db/client.ts";
import { settings } from "#lib/db/settings.ts";
import {
  parsePositiveInt,
  PRUNE_INTERVAL_MS,
  PRUNE_LOGINS_RETENTION_MS,
  PRUNE_PAYMENTS_RETENTION_MS,
  PRUNE_SESSIONS_RETENTION_MS,
} from "#lib/limits.ts";
import { logDebug } from "#lib/logger.ts";
import { nowMs } from "#lib/now.ts";

/**
 * Delete finalized processed_payments rows older than the retention window.
 * Unfinalized (attendee_id IS NULL) rows are handled by deleteAllStaleReservations
 * in processed-payments.ts — we leave them alone here.
 */
export const prunePayments = async (): Promise<number> => {
  const cutoffIso = new Date(
    nowMs() - PRUNE_PAYMENTS_RETENTION_MS,
  ).toISOString();
  const result = await getDb().execute({
    args: [cutoffIso],
    sql: "DELETE FROM processed_payments WHERE attendee_id IS NOT NULL AND processed_at < ?",
  });
  return result.rowsAffected;
};

/**
 * Delete sessions whose `expires` is older than (now - retention window).
 * Uses millisecond-epoch numeric comparison (same format as the column).
 */
export const pruneSessions = async (): Promise<number> => {
  const cutoffMs = nowMs() - PRUNE_SESSIONS_RETENTION_MS;
  const result = await getDb().execute({
    args: [cutoffMs],
    sql: "DELETE FROM sessions WHERE expires < ?",
  });
  return result.rowsAffected;
};

/**
 * Delete login_attempts rows whose lockout expired more than the retention
 * window ago. Rows with NULL `locked_until` have no timestamp and are left
 * alone (they will be overwritten on the next attempt from that IP).
 */
export const pruneLoginAttempts = async (): Promise<number> => {
  const cutoffMs = nowMs() - PRUNE_LOGINS_RETENTION_MS;
  const result = await getDb().execute({
    args: [cutoffMs],
    sql: "DELETE FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until < ?",
  });
  return result.rowsAffected;
};

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
