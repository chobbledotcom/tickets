/**
 * Running the migrations that are still outstanding: which ones are missing,
 * how each one is applied and re-checked, and how partial progress is kept.
 */

import { errorMessage } from "#shared/error-message.ts";
import { logDebug } from "#shared/logger.ts";
import { retryWithBackoff } from "#shared/retry.ts";

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
 * Backoff (ms) before each re-attempt of a migration's verify(). Its length is
 * the number of retries, so four verify attempts in total.
 *
 * A migration applies DDL in up() and then verify() reads the live schema back
 * to confirm it landed. The snapshot is already pinned to the primary
 * (queryBatchPrimary, "write" mode) to dodge replica lag, but a freshly-opened
 * primary connection can still briefly observe the pre-DDL schema —
 * read-your-writes propagation lag — so a column the ALTER just added reads as
 * missing and verify() throws spuriously. (Observed in production: a column-add
 * migration failed verification on one request and passed on the retry moments
 * later.) verify() re-snapshots on every call, so retrying after a short backoff
 * lets the schema settle within the same request rather than 503-ing it. A
 * genuine schema defect stays missing across every attempt and still throws, so
 * this never masks a real bug.
 *
 * Retrying verify() alone is not always enough, though: up() can itself skip a
 * write when its own snapshot lagged. syncIndexes() reads the live schema to
 * decide which indexes to create and skips any whose table the snapshot doesn't
 * show — correct for an index on a table a later migration creates, but it also
 * skips an index whose table THIS migration just created when the read lags
 * behind that write. The index is then never created, so verify() fails on every
 * attempt until up() runs again — the observed "missing index
 * idx_system_notes_attendee_id, passed on the next request" failure. So once
 * verify()'s own retries are exhausted, {@link applyMigrationWithRetry} re-runs
 * up() once and verifies again.
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
 *
 * Re-running up() repairs the case where up() itself skipped a write because its
 * own schema snapshot lagged (see VERIFY_RETRY_BACKOFF_MS) — the missing-index
 * failure. up() is idempotent by construction (the runner already re-runs it on
 * a later request whenever a prior run died before recording its marker), so the
 * second pass — now reading a settled snapshot — completes the skipped write.
 *
 * The re-run is deferred until verify()'s own retries are exhausted, not fired
 * on the first verify miss, so a migration whose up() is NOT a cheap no-op after
 * success — e.g. 2026-06-20_free_text_questions, which recopies attendee_answers
 * / listing_questions / questions via recreateTable — is not re-run on a pure
 * verify-lag (up() did its work; only verify()'s snapshot lagged), which would
 * recopy large tables and risk the edge request budget. up() therefore runs at
 * most twice, never once per retry.
 */
export const applyMigrationWithRetry = async (
  migration: Migration,
): Promise<void> => {
  await migration.up();
  try {
    await verifyMigrationWithRetry(migration);
  } catch (error) {
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

export const runPendingMigrations = async (
  pending: Migration[],
  lockToken: string,
): Promise<void> => {
  const completed: Migration[] = [];
  try {
    for (const migration of pending) {
      logDebug(
        "Migration",
        `Running ${migration.id}: ${migration.description}`,
      );
      await applyMigrationWithRetry(migration);
      completed.push(migration);
    }
  } catch (error) {
    // Keep successful progress when a later migration fails. The success path
    // writes these markers with the schema markers and lock release below.
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
