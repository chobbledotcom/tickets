/**
 * Running the migrations that are still outstanding: which ones are missing,
 * how each one is applied and re-checked, and how partial progress is kept.
 */

import { isDatabaseRoundTripLimited } from "#db/query-log.ts";
import { errorMessage } from "#shared/error-message.ts";
import { logDebug } from "#shared/logger.ts";
import { retryWithBackoff } from "#shared/retry.ts";
import {
  BUNNY_SUBREQUEST_LIMIT,
  getSubrequestRemaining,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { loadMigrations } from "./context.ts";
import { combinedFailures } from "./errors.ts";
import {
  getAppliedMigrationIds,
  markMigrationsApplied,
  recordCompletedProgress,
  writeSchemaMarkers,
} from "./markers.ts";
import { MIGRATION_IDS } from "./registry.ts";
import { verifyCurrentAppSchema } from "./schema-sync.ts";
import type { Migration } from "./types.ts";

/**
 * Round-trips held back so recording progress and releasing the lock always
 * fit, even when the migrations fill the request's subrequest budget.
 *
 * Without the reserve, a batch that spends the whole budget cannot write its
 * progress markers or release the lock. The database then makes no forward
 * progress and stays locked until the TTL expires, and every reload in that
 * window is turned away and re-runs the same over-budget batch.
 */
const MIGRATION_BOOKKEEPING_RESERVE = 5;

/** True when `error` is the "subrequest budget spent" signal countSubrequest
 *  raises at the reserve cap — the cue to stop the batch here rather than a
 *  migration defect. The cap always trips this budget guard before the wider
 *  round-trip limit, so that is the only message to match. */
const isSubrequestBudgetError = (error: unknown): boolean =>
  errorMessage(error).startsWith("Subrequest allowance exceeded");

/** The migrations whose ids are not yet recorded as applied, in run order.
 *  Checks the ids first so the implementations only load when at least one
 *  migration is actually missing. */
export const missingMigrations = async (): Promise<Migration[]> => {
  const applied = await getAppliedMigrationIds();
  if (MIGRATION_IDS.every((id) => applied.has(id))) return [];
  return (await loadMigrations()).filter(
    (migration) => !applied.has(migration.id),
  );
};

export const baselineCurrentSchemaIfNeeded = async (): Promise<void> => {
  const missing = await missingMigrations();
  if (missing.length === 0) return;

  await verifyCurrentAppSchema();
  logDebug(
    "Migration",
    `Baselining ${missing.length} already-applied migration(s)`,
  );
  await markMigrationsApplied(missing);
};

/**
 * Backoff before each re-attempt of a migration's verify(). Its length is the
 * number of retries.
 *
 * The snapshot is pinned to the primary to dodge replica lag, but a fresh
 * primary connection can still briefly observe the pre-DDL schema, so a column
 * the ALTER just added reads as missing and verify() throws spuriously. A short
 * backoff lets the schema settle within the same request rather than 503 it,
 * and a genuine defect stays missing across every attempt.
 */
export const VERIFY_RETRY_BACKOFF_MS = [50, 150, 350] as const;

/**
 * Run a migration's verify(), retrying a transient failure (read-your-writes
 * lag on the just-applied DDL) on a fresh schema snapshot before giving up.
 */
export const verifyMigrationWithRetry = (migration: Migration): Promise<void> =>
  retryWithBackoff(
    () => migration.verify(),
    VERIFY_RETRY_BACKOFF_MS,
    (error, { attempt, willRetry }) => {
      // A spent subrequest budget is not a transient lag: retrying just burns
      // the reserve. Propagate so the batch stops and its progress is recorded.
      if (isSubrequestBudgetError(error)) throw error;
      if (!willRetry) return;
      logDebug(
        "Migration",
        `verify ${migration.id} failed on attempt ${attempt + 1}, retrying: ${errorMessage(
          error,
        )}`,
      );
    },
  );

/**
 * Apply a migration: run up(), then verify() with retries. If verify() never
 * passes across a full round of retries, re-run up() once and verify again.
 * That repairs an up() which skipped a write because its own schema snapshot
 * lagged (see VERIFY_RETRY_BACKOFF_MS). up() is idempotent by construction: the
 * runner already re-runs it whenever a prior run died before its marker landed.
 *
 * The re-run waits for verify()'s retries to run out and never fires on the
 * first miss. Some up() work is not a cheap no-op after success, because a
 * migration such as the free-text-questions one recopies whole tables, and a
 * pure verify-lag must not re-run that and risk the edge request budget.
 */
export const applyMigrationWithRetry = async (
  migration: Migration,
): Promise<void> => {
  await migration.up();
  try {
    await verifyMigrationWithRetry(migration);
  } catch (error) {
    // Re-running up() to repair a lagged snapshot only helps a transient miss;
    // an over-budget request has no budget left for a second up(), so hand the
    // signal back to stop the batch instead.
    if (isSubrequestBudgetError(error)) throw error;
    logDebug(
      "Migration",
      `verify ${migration.id} still failing after retries, re-running up(): ${errorMessage(
        error,
      )}`,
    );
    await migration.up();
    await verifyMigrationWithRetry(migration);
  }
};

/** Apply each pending migration in turn, appending the ones that finish to
 *  `completed`. Stops early — leaving the rest for the next request — once the
 *  reserved subrequest budget is reached. A real migration failure still
 *  throws. */
const applyUntilBudgetSpent = async (
  pending: Migration[],
  completed: Migration[],
): Promise<void> => {
  for (const migration of pending) {
    logDebug("Migration", `Running ${migration.id}: ${migration.description}`);
    try {
      await applyMigrationWithRetry(migration);
    } catch (error) {
      // Out of budget: stop here so the caller records what finished and the
      // next request continues. The half-applied migration is idempotent, so
      // it re-runs cleanly from the top next time.
      if (isSubrequestBudgetError(error)) return;
      throw error;
    }
    completed.push(migration);
  }
};

/**
 * Apply the outstanding migrations, returning the ones that finished this
 * request.
 *
 * On the edge each request has a fixed subrequest budget, so the run is capped
 * to leave {@link MIGRATION_BOOKKEEPING_RESERVE} round-trips for the caller to
 * record progress and release the lock; when that cap is reached the run stops
 * and the returned list is short of `pending`, so the caller continues on the
 * next request. Off the edge (a CLI/back-up run with no request budget) there is
 * no cap and every migration runs. A genuine migration failure throws, after the
 * already-finished migrations are recorded so their progress is not lost.
 */
export const runPendingMigrations = async (
  pending: Migration[],
  lockToken: string,
): Promise<Migration[]> => {
  const completed: Migration[] = [];
  try {
    if (isDatabaseRoundTripLimited()) {
      const budget = Math.max(
        1,
        getSubrequestRemaining().database - MIGRATION_BOOKKEEPING_RESERVE,
      );
      await withSubrequestAllowance(
        { database: budget, external: BUNNY_SUBREQUEST_LIMIT, total: budget },
        () => applyUntilBudgetSpent(pending, completed),
      );
    } else {
      await applyUntilBudgetSpent(pending, completed);
    }
  } catch (error) {
    // Keep successful progress when a later migration fails. This records
    // outside the capped allowance above, so the reserve pays for it.
    if (completed.length > 0) {
      try {
        await recordCompletedProgress(completed, lockToken);
      } catch (markerError) {
        throw combinedFailures(
          "Database migration failed and completed progress could not be recorded.",
          error,
          markerError,
        );
      }
    }
    throw error;
  }
  return completed;
};

/**
 * Stale markers with nothing pending happen two ways: a previous run was
 * killed after recording its migrations but before refreshing the markers
 * (verification passes — rewrite the markers), or SCHEMA was changed without
 * adding a named migration (verification fails — refuse to guess).
 */
export const restoreStaleSchemaMarkers = async (): Promise<void> => {
  try {
    await verifyCurrentAppSchema();
  } catch (error) {
    const detail = errorMessage(error);
    throw new Error(
      "Database schema markers are stale, no named migrations are pending, " +
        `and the live schema does not match (${detail}). ` +
        "Every SCHEMA change must ship with a new entry in MIGRATIONS.",
    );
  }
  logDebug("Migration", "Schema verified; restoring stale schema markers");
  await writeSchemaMarkers();
};
