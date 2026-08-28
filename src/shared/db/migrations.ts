/**
 * Declarative schema with algorithmic application. To change the schema, add to
 * the table's `columns`, to SCHEMA after its FK dependencies, or to `indexes`.
 * Then update LATEST_UPDATE. The schema hash is computed automatically, so
 * migrations still re-run when you forget.
 *
 * This file is the boot path only. It works out what state the database is in
 * and routes to the right response.
 */

import type { Client } from "@libsql/client";
import { executeBatch, getDb, inPlaceholders } from "#db/client.ts";
import { lazyRef } from "#fp";
import { resetAllCaches } from "#shared/cache-registry.ts";
import { logDebug } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { addPendingWork, hasPendingWorkScope } from "#shared/pending-work.ts";
import { recordScriptVersion } from "#shared/update.ts";
import {
  ensureDefaultAttendeeStatus,
  loadMigrations,
} from "./migrations/context.ts";
import {
  isMissingMigrationsTableError,
  isMissingSettingsTableError,
  MigrationInProgressError,
  MissingSettingsTableError,
} from "./migrations/errors.ts";
import {
  acquireMigrationLock,
  migrationLockHeldError,
  releaseAfterMigrationFailure,
  releaseMigrationLock,
  storedLease,
} from "./migrations/lock.ts";
import {
  migrationMarkerStatement,
  recordMigrationBatch,
  schemaMarkerStatements,
} from "./migrations/markers.ts";
import { MIGRATION_IDS } from "./migrations/registry.ts";
import {
  baselineCurrentSchemaIfNeeded,
  missingMigrations,
  restoreStaleSchemaMarkers,
  runPendingMigrations,
} from "./migrations/runner.ts";
import { SCHEMA, SCHEMA_HASH } from "./migrations/schema/index.ts";
import { TRIGGERS } from "./migrations/schema/triggers.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  LATEST_UPDATE,
  SCHEMA_MIGRATIONS_TABLE,
} from "./migrations/schema/version.ts";
import {
  applySchemaChanges,
  fullSchemaCreateStatements,
  noArgStatements,
  syncIndexes,
  syncTriggers,
} from "./migrations/schema-sync.ts";
import type { Migration } from "./migrations/types.ts";

export { SCHEMA_HASH, SCHEMA_TABLE_NAMES } from "./migrations/schema/index.ts";
export { LATEST_UPDATE } from "./migrations/schema/version.ts";
export type { Migration, SchemaRequirement } from "./migrations/types.ts";

// ─── Probing the database's state ───────────────────────────────

type DbState =
  | "up_to_date"
  | "needs_migration"
  | "missing_settings"
  | "uninitialized_settings";

/** Everything the boot path needs to know, answered by one round trip. */
type DbProbe = {
  state: DbState;
  /** Count of *current* migration ids recorded (orphaned rows from renamed
   *  migrations are ignored), or null when the table is missing. */
  appliedMigrations: number | null;
};

const SCHEMA_MARKERS_SQL = `SELECT key, value FROM settings WHERE key IN ('${LATEST_DB_UPDATE_KEY}', '${DB_SCHEMA_HASH_KEY}')`;

/** Turn a probe's key/value rows into a lookup map. */
const rowsToMap = (rows: readonly Record<string, unknown>[]) =>
  new Map(rows.map((row) => [row.key as string, row.value as string]));

/** Read the schema state from the marker rows a probe returned. */
const markerState = (values: Map<string, string>): DbState => {
  if (!values.has(LATEST_DB_UPDATE_KEY) && !values.has(DB_SCHEMA_HASH_KEY)) {
    return "uninitialized_settings";
  }
  return values.get(LATEST_DB_UPDATE_KEY) === LATEST_UPDATE &&
    values.get(DB_SCHEMA_HASH_KEY) === SCHEMA_HASH
    ? "up_to_date"
    : "needs_migration";
};

const MISSING_SETTINGS_PROBE: DbProbe = {
  appliedMigrations: null,
  state: "missing_settings",
};

/** Run one probe query and translate its rows or failure into a DbProbe. */
const runProbeQuery = async (
  sql: string,
  args: string[],
  toProbe: (values: Map<string, string>) => DbProbe,
  onMissingHistory?: () => Promise<DbProbe>,
): Promise<DbProbe> => {
  try {
    const result = await getDb().execute({ args, sql });
    return toProbe(rowsToMap(result.rows));
  } catch (error) {
    if (isMissingSettingsTableError(error)) return MISSING_SETTINGS_PROBE;
    if (onMissingHistory && isMissingMigrationsTableError(error)) {
      return onMissingHistory();
    }
    throw error;
  }
};

/** Probe fallback when schema_migrations doesn't exist (settings may be
 *  missing too — SQLite reports one missing table at a time). */
const probeWithoutHistory = (): Promise<DbProbe> =>
  runProbeQuery(SCHEMA_MARKERS_SQL, [], (values) => ({
    appliedMigrations: null,
    state: markerState(values),
  }));

/** Read the schema state AND count the recorded migration history in one
 *  round trip — every isolate's first request pays for this. */
const probeDbState = (): Promise<DbProbe> => {
  const ids = MIGRATION_IDS;
  return runProbeQuery(
    `${SCHEMA_MARKERS_SQL} UNION ALL SELECT 'applied_migrations', ` +
      `CAST(COUNT(*) AS TEXT) FROM ${SCHEMA_MIGRATIONS_TABLE} ` +
      `WHERE id IN (${inPlaceholders(ids)})`,
    ids,
    (values) => ({
      appliedMigrations: Number(values.get("applied_migrations")),
      state: markerState(values),
    }),
    probeWithoutHistory,
  );
};

// ─── Creating a schema from scratch ─────────────────────────────

/** Seed and stamp a freshly created schema: the default attendee status, the
 *  schema markers, and every migration recorded as applied — so the next boot
 *  treats the database as fully migrated. Shared by the fresh-install path and
 *  the restore rebuild. */
const sealFreshSchema = async (): Promise<void> => {
  await ensureDefaultAttendeeStatus();
  const migrations = await loadMigrations();
  const appliedAt = nowIso();
  await executeBatch([
    ...schemaMarkerStatements(),
    ...migrations.map((migration) =>
      migrationMarkerStatement(migration, appliedAt),
    ),
  ]);
};

/**
 * Initialize a brand-new database directly from the current declarative schema.
 *
 * Empty databases do not need to replay every historical migration and verifier:
 * there is no legacy data to backfill or reshape. Creating the latest schema in
 * one pass keeps first boot fast while still recording every migration marker so
 * future boots use the normal up-to-date path.
 */
const initializeFreshSchema = async (): Promise<void> => {
  logDebug("Migration", "Initializing fresh database from current schema");
  await applySchemaChanges();
  await syncIndexes();
  await syncTriggers();
  await sealFreshSchema();
};

/**
 * Rebuild the full schema after resetDatabase(), WITHOUT reading the database
 * to decide what to create.
 *
 * Right after the drops, a replica and even a freshly-routed primary connection
 * can briefly serve the pre-wipe schema. A lagged answer used to either route
 * boot into schema verification against the wiped primary, or make the rebuild
 * skip its CREATEs and die at the next write, which left the database empty.
 *
 * So every statement here is unconditional and idempotent, and nothing is
 * consulted first.
 */
export const rebuildWipedSchema = async (): Promise<void> => {
  logDebug("Migration", "Rebuilding wiped database from current schema");
  await executeBatch(noArgStatements(fullSchemaCreateStatements()));
  // executeMultiple accepts a SQL script, so it preserves each compound
  // trigger body while rebuilding every trigger in one network round trip.
  await getDb().executeMultiple(
    `${TRIGGERS.map((trigger) => trigger.sql).join(";\n")};`,
  );
  await sealFreshSchema();
};

// ─── Main migration ─────────────────────────────────────────────

/** A single migration that cannot finish within one request's subrequest
 *  budget would stall forever — every reload re-runs it and hits the same wall.
 *  Fail loudly instead, naming the migration to split. */
const migrationTooLargeError = (migration: Migration): Error =>
  new Error(
    `Migration ${migration.id} needs more database round-trips than a single ` +
      "request allows, so it cannot finish on the edge. Split it into smaller " +
      "migrations.",
  );

type InitDbOptions = {
  /** Only setup/restore/bootstrap callers should create a missing settings table. */
  allowMissingSettings?: boolean;
};

/**
 * The client most recently confirmed ready by initDb. initDb runs on every
 * request, so once a client is confirmed the hot path must cost zero
 * queries. Only success is cached — failures are retried on the next call.
 */
const [getReadyClient, setReadyClient] = lazyRef<Client | null>(() => null);

/** Forget the per-isolate "database is ready" cache. */
export const invalidateInitDbCache = (): void => {
  setReadyClient(null);
};

/**
 * Initialize database tables for an existing database.
 * Fresh database creation requires allowMissingSettings.
 * Uses an advisory lock to prevent concurrent migrations.
 */
export const initDb = async (opts: InitDbOptions = {}): Promise<void> => {
  const client = getDb();
  if (client === getReadyClient()) return;
  await initDbUncached(opts.allowMissingSettings ?? false);
  // Self-record the running build's version so a parent host can read it back.
  // Best-effort and once per isolate (initDb caches the ready client below).
  // Pending work inside a request (overlaps instead of gating the first
  // response); callers outside a request scope still wait for it.
  const recorded = recordScriptVersion();
  if (hasPendingWorkScope()) {
    addPendingWork(recorded);
  } else {
    await recorded;
  }
  setReadyClient(client);
};

const requireAllowedInitialDbState = (
  state: DbState,
  allowMissingSettings: boolean,
): void => {
  if (allowMissingSettings) return;
  if (state === "missing_settings") throw new MissingSettingsTableError();
  if (state === "uninitialized_settings") {
    throw new MissingSettingsTableError(
      "Database settings table is uninitialized",
    );
  }
};

/** Finish the boot path when the markers match this build; the baseline
 *  reconcile runs only when the probe found the history incomplete (a
 *  restored database), so a steady-state boot pays no extra round trips. */
const finishIfUpToDate = async (probe: DbProbe): Promise<boolean> => {
  if (probe.state !== "up_to_date") return false;
  if (probe.appliedMigrations !== MIGRATION_IDS.length) {
    await baselineCurrentSchemaIfNeeded();
  }
  return true;
};

type LockedMigrationResult = "continue" | "release" | "released";

const runAcquiredMigrations = async (
  recheck: DbProbe,
  lockToken: string,
): Promise<LockedMigrationResult> => {
  if (await finishIfUpToDate(recheck)) return "release";

  if (
    recheck.state === "missing_settings" ||
    recheck.state === "uninitialized_settings"
  ) {
    await initializeFreshSchema();
    return "release";
  }

  const pending = await missingMigrations();
  if (pending.length === 0) {
    await restoreStaleSchemaMarkers();
    return "release";
  }

  // How many migrations run this request is set by the subrequest budget, not a
  // fixed count: runPendingMigrations applies as many as fit and holds back the
  // headroom that recording progress and releasing the lock need, so a stale
  // database advances on every reload instead of stalling on a full batch.
  // (Back-ups run out-of-band because the edge budget cannot fit a full dump.)
  const completed = await runPendingMigrations(pending, lockToken);
  if (completed.length === 0) throw migrationTooLargeError(pending[0]!);

  const finished = completed.length === pending.length;
  logDebug(
    "Migration",
    finished
      ? "Updating version marker..."
      : `Recorded ${completed.length} migrations; continuing on the next request...`,
  );
  await recordMigrationBatch(completed, finished, lockToken);
  return finished ? "released" : "continue";
};

const initDbUncached = async (allowMissingSettings: boolean): Promise<void> => {
  const probe = await probeDbState();
  if (await finishIfUpToDate(probe)) return;
  requireAllowedInitialDbState(probe.state, allowMissingSettings);

  const lease = await acquireMigrationLock(allowMissingSettings);
  if (lease === null) throw migrationLockHeldError();

  // Only a stored lease is ever given back: a database with no settings table
  // has no row to delete, and trying would swap this request's retry message
  // for whatever the pointless write failed with.
  let held = lease;
  let result: LockedMigrationResult;
  try {
    // Re-check after acquiring the lock because another process may have
    // finished, which is also what decides whether the lease is real yet.
    const recheck = await probeDbState();
    held = await storedLease(lease, recheck.state === "missing_settings");
    result = await runAcquiredMigrations(recheck, held.token);
  } catch (error) {
    if (!held.stored) throw error;
    return await releaseAfterMigrationFailure(held.token, error);
  }
  if (result === "release" && held.stored) {
    await releaseMigrationLock(held.token);
  }
  if (result === "continue") {
    throw new MigrationInProgressError(
      "Database update is continuing on the next request.",
    );
  }
};

// ─── Reset ──────────────────────────────────────────────────────

/** Clear every module-level in-process cache.
 *
 *  Call after any operation that bypasses the normal write path (full reset,
 *  restore from backup) so stale reads cannot outlive the current isolate
 *  lifecycle. Both resetDatabase (in its finally block, so even a partial-drop
 *  failure invalidates caches) and restoreFromSql (after executeBatch completes)
 *  use this to guarantee a consistent post-operation view.
 *
 *  The caches themselves register with the cache registry when their modules
 *  load (a lazily-loaded module that never ran has no cache to clear), so this
 *  needs no static import of any cache module — only the per-isolate initDb
 *  ready-client cache lives here. */
export const clearAllCaches = (): void => {
  invalidateInitDbCache();
  resetAllCaches();
};

/**
 * Reset the database by dropping all tables (reverse order for FK safety)
 */
export const resetDatabase = async (): Promise<void> => {
  try {
    await executeBatch(
      [...SCHEMA].reverse().map(([name]) => ({
        args: [],
        sql: `DROP TABLE IF EXISTS ${name}`,
      })),
    );
  } finally {
    clearAllCaches();
  }
};
