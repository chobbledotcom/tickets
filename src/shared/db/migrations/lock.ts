/**
 * The advisory lock that stops two isolates migrating the same database at
 * once, and the statement wrappers that keep every write conditional on still
 * holding it.
 */

import type { SqlStatement } from "#shared/db/client.ts";
import { executeBatchWithResults, getDb } from "#shared/db/client.ts";
import { getEnv } from "#shared/env.ts";
import { errorMessage } from "#shared/error-message.ts";
import { sendNtfyError } from "#shared/ntfy.ts";

import {
  combinedFailures,
  isMissingSettingsTableError,
  MigrationInProgressError,
} from "./errors.ts";
import { MIGRATION_LOCK_KEY } from "./schema/version.ts";

/**
 * A migration lock older than this is treated as abandoned and stolen.
 * Migrations run inline on edge isolates that can be evicted mid-run,
 * orphaning the lock; the TTL lets the next boot self-heal instead of
 * requiring a manual DELETE FROM settings.
 */
const MIGRATION_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * A migration lock this request holds. `stored` is false only for the tolerated
 * acquisition against a database with no `settings` table: there was no row to
 * write, so nothing backs the token until that table exists.
 */
export type MigrationLease = { stored: boolean; token: string };

/**
 * Acquire an advisory migration lock via the settings table.
 * Returns this request's timestamp-prefixed lease when acquired, or null
 * when another process holds a fresh lock. The ISO-8601 prefix sorts
 * lexicographically, so one atomic UPSERT both takes a free lock and steals an
 * expired one: DO UPDATE only fires when the held lock predates the cutoff, and
 * a fresh lock leaves rowsAffected at 0. The random suffix lets completion and
 * cleanup prove they still own this exact lease.
 */
export const acquireMigrationLock = async (
  allowMissingSettings: boolean,
): Promise<MigrationLease | null> => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - MIGRATION_LOCK_TTL_MS).toISOString();
  const stamp = now.toISOString();
  const lockToken = `${stamp}|${crypto.randomUUID()}`;
  const result = await getDb()
    .execute({
      args: [MIGRATION_LOCK_KEY, lockToken, lockToken, cutoff],
      sql:
        "INSERT INTO settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = ? WHERE settings.value < ?",
    })
    .catch((error) => {
      if (allowMissingSettings && isMissingSettingsTableError(error)) {
        return null;
      }
      throw error;
    });
  if (result === null) return { stored: false, token: lockToken };
  return result.rowsAffected === 1 ? { stored: true, token: lockToken } : null;
};

/** Tell a request another one is migrating, and let the operator know. */
export const migrationLockHeldError = (): MigrationInProgressError => {
  void sendNtfyError(`E_DB_MIGRATION_LOCK ${getEnv("DB_URL") ?? "unknown"}`);
  return new MigrationInProgressError(
    "Database migration is already in progress (migration_lock held). " +
      `The request can be retried; a crashed migration's lock is reclaimed automatically after ${
        MIGRATION_LOCK_TTL_MS / 60000
      } minutes, or manually DELETE FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'.`,
  );
};

/**
 * The lease this request may actually write with.
 *
 * A lease taken while the `settings` table was missing has no row behind it. If
 * another request created that table in the meantime, the token owns nothing, so
 * take a real lease before any lock-gated write — and step aside if that other
 * request is still holding one.
 */
export const storedLease = async (
  lease: MigrationLease,
  settingsStillMissing: boolean,
): Promise<MigrationLease> => {
  if (lease.stored || settingsStillMissing) return lease;
  const retaken = await acquireMigrationLock(false);
  if (retaken === null) throw migrationLockHeldError();
  return retaken;
};

/** The statement that gives up this request's lease. */
export const releaseMigrationLockStatement = (
  lockToken: string,
): SqlStatement => ({
  args: [MIGRATION_LOCK_KEY, lockToken],
  sql: "DELETE FROM settings WHERE key = ? AND value = ?",
});

/** Release only the migration lock lease acquired by this request. */
export const releaseMigrationLock = (lockToken: string): Promise<unknown> =>
  getDb().execute(releaseMigrationLockStatement(lockToken));

/** Make a statement do nothing unless this request still holds the lease. */
export const whileMigrationLockOwned = (
  sql: string,
  args: SqlStatement["args"],
  lockToken: string,
): SqlStatement => ({
  args: [...args, MIGRATION_LOCK_KEY, lockToken],
  sql: `${sql} WHERE EXISTS (SELECT 1 FROM settings WHERE key = ? AND value = ?)`,
});

/** Run statements in one batch that fails when the lease has been lost. */
export const executeWhileMigrationLockOwned = async (
  statements: SqlStatement[],
  lockToken: string,
): Promise<void> => {
  const [ownership] = await executeBatchWithResults([
    {
      args: [MIGRATION_LOCK_KEY, lockToken],
      sql: "UPDATE settings SET value = value WHERE key = ? AND value = ?",
    },
    ...statements,
  ]);
  if (ownership!.rowsAffected !== 1) {
    throw new MigrationInProgressError(
      "Database migration lock ownership was lost before completion.",
    );
  }
};

/** Give the lock back after a failed migration, then re-raise the failure. */
export const releaseAfterMigrationFailure = async (
  lockToken: string,
  failure: unknown,
): Promise<never> => {
  try {
    await releaseMigrationLock(lockToken);
  } catch (releaseError) {
    throw combinedFailures(
      `Database migration failed and its lock could not be released: ${errorMessage(
        failure,
      )}; ${errorMessage(releaseError)}`,
      failure,
      releaseError,
    );
  }
  throw failure;
};
