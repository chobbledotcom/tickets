/**
 * Database migrations — declarative schema with algorithmic application
 *
 * To modify the schema:
 * - Add a column: add it to the table's `columns` array
 * - Add a table: add it to SCHEMA (after its FK dependencies)
 * - Add an index: add it to the table's `indexes` array
 *
 * Then update LATEST_UPDATE to describe the change.
 * The schema hash is computed automatically — if you forget to update
 * LATEST_UPDATE, migrations will still re-run (the hash will differ).
 */

import type { Client } from "@libsql/client";
import { lazyRef, once } from "#fp";
import { resetAllCaches } from "#shared/cache-registry.ts";
import { executeBatch, getDb, inPlaceholders } from "#shared/db/client.ts";
import { getEnv } from "#shared/env.ts";
import { logDebug } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { addPendingWork, hasPendingWorkScope } from "#shared/pending-work.ts";
import { retryWithBackoff } from "#shared/retry.ts";
import { recordScriptVersion } from "#shared/update.ts";
import { MIGRATION_IDS, MIGRATION_REGISTRY } from "./migrations/registry.ts";
import { EVENT_TO_LISTING_RENAME_PLAN } from "./migrations/rename-plan.ts";
import { repairLegacyRenames } from "./migrations/rename-utils.ts";
import {
  LATEST_UPDATE,
  SCHEMA,
  SCHEMA_HASH,
  SCHEMA_MIGRATIONS_TABLE,
  TRIGGERS,
} from "./migrations/schema.ts";
import {
  applySchemaChanges,
  backfillAnswerAggregates,
  backfillListingAggregates,
  backfillModifierAggregates,
  createTableSql,
  fullSchemaCreateStatements,
  recreateTable,
  runMigration,
  syncCurrentSchema as syncCurrentSchemaBase,
  syncIndexes,
  syncTriggers,
  tableExists,
  verifyCurrentAppSchema,
} from "./migrations/schema-sync.ts";
import type { Migration, MigrationContext } from "./migrations/types.ts";
import { additive, verifyRequirement } from "./migrations/verify.ts";

export {
  LATEST_UPDATE,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "./migrations/schema.ts";
export type { Migration, SchemaRequirement } from "./migrations/types.ts";

// ─── Helpers ────────────────────────────────────────────────────

type DbState =
  | "up_to_date"
  | "needs_migration"
  | "missing_settings"
  | "uninitialized_settings";

export class MissingSettingsTableError extends Error {
  constructor(message = "Database settings table does not exist") {
    super(message);
    this.name = "MissingSettingsTableError";
  }
}

/**
 * Thrown when another isolate holds the migration lock — i.e. a database
 * migration (including its pre-migration backup) is already running. The
 * request can be retried once the migration finishes, so callers surface a
 * dedicated "migration in progress" page that auto-refreshes rather than the
 * generic temporary-error page.
 */
export class MigrationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationInProgressError";
  }
}

/** Build a checker for "this exact table is missing" database errors. */
const missingTableError =
  (table: string) =>
  (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return new RegExp(`no such table:?\\s*(\\w+\\.)?${table}\\b`, "i").test(
      message,
    );
  };

const isMissingSettingsTableError = missingTableError("settings");
const isMissingMigrationsTableError = missingTableError("schema_migrations");

/** Everything the boot path needs to know, answered by one round trip. */
type DbProbe = {
  state: DbState;
  /** Count of *current* migration ids recorded (orphaned rows from renamed
   *  migrations are ignored), or null when the table is missing. */
  appliedMigrations: number | null;
};

const SCHEMA_MARKERS_SQL =
  "SELECT key, value FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash')";

/** Turn a probe's key/value rows into a lookup map. */
const rowsToMap = (rows: readonly Record<string, unknown>[]) =>
  new Map(rows.map((row) => [row.key as string, row.value as string]));

/** Read the schema state from the marker rows a probe returned. */
const markerState = (values: Map<string, string>): DbState => {
  if (!values.has("latest_db_update") && !values.has("db_schema_hash")) {
    return "uninitialized_settings";
  }
  return values.get("latest_db_update") === LATEST_UPDATE &&
    values.get("db_schema_hash") === SCHEMA_HASH
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

/**
 * Rename the legacy "event" domain to "listing". Public entrypoint so tests
 * can drive the rename directly; in production it is called by the baseline
 * reconcile and by the `2026-06-14_rename_events_to_listings` migration (as an
 * idempotent verification/cleanup step).
 */
export const renameEventsToListings = async (): Promise<void> => {
  await repairLegacyRenames(EVENT_TO_LISTING_RENAME_PLAN);
  await applySchemaChanges();
  await syncIndexes();
};

const syncCurrentSchema = async (): Promise<void> => {
  await syncCurrentSchemaBase(() =>
    repairLegacyRenames(EVENT_TO_LISTING_RENAME_PLAN),
  );
};

/** Seed the default attendee status. Loaded on demand: only migration,
 *  fresh-install, and restore paths need it, and a static import would put the
 *  attendee-statuses module into every cold start's eager graph. */
const ensureDefaultAttendeeStatus = async (): Promise<void> => {
  const { ensureDefaultAttendeeStatus: seedDefaultStatus } = await import(
    "#shared/db/attendee-statuses.ts"
  );
  await seedDefaultStatus();
};

const migrationContext: MigrationContext = {
  additive,
  applySchemaChanges,
  backfillAnswerAggregates,
  backfillListingAggregates,
  backfillModifierAggregates,
  ensureDefaultAttendeeStatus,
  getDb,
  recreateTable,
  renameEventsToListings,
  syncCurrentSchema,
  syncIndexes,
  syncTriggers,
  tableExists,
  verifyCurrentAppSchema,
  verifyRequirement,
};

/**
 * Load and build every migration, in run order. Deliberately lazy (and cached
 * after the first call): a steady-state boot only ever needs the migration
 * *ids* for its probe, so the ~70 dated migration modules — and the domain
 * modules they import — stay out of the cold-start graph and load only on the
 * rare request that has real migration work (or a fresh install) to do.
 */
export const loadMigrations = once(async (): Promise<Migration[]> => {
  const modules = await Promise.all(
    MIGRATION_REGISTRY.map((migration) => migration.load()),
  );
  return modules.map((module) => module.default(migrationContext));
});

/** Seed and stamp a freshly created schema: the default attendee status, the
 *  schema markers, and every migration recorded as applied — so the next boot
 *  treats the database as fully migrated. Shared by the fresh-install path and
 *  the restore rebuild. */
const sealFreshSchema = async (): Promise<void> => {
  await ensureDefaultAttendeeStatus();
  await writeSchemaMarkers();
  await markMigrationsApplied(await loadMigrations());
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
 * Rebuild the full schema on a database that resetDatabase() just wiped,
 * without reading the database to decide what to create.
 *
 * The restore path cannot trust any schema or state read taken here: right
 * after the drops, a replica AND even a freshly-routed primary connection can
 * briefly serve the pre-wipe schema (read-your-writes propagation lag — the
 * same effect VERIFY_RETRY_BACKOFF_MS documents). A lagged answer either
 * routed boot into schema verification against the wiped primary ("missing
 * table settings", via initDb's state check) or made the rebuild skip its
 * CREATEs and die at the next write ("no such table: settings"), leaving the
 * operator's database empty. So every statement here is unconditional and
 * idempotent (IF NOT EXISTS), and nothing is consulted first. A just-wiped
 * database has no legacy tables by definition, so the additive column
 * reconciliation initializeFreshSchema performs (via applySchemaChanges) is
 * not needed here.
 */
export const rebuildWipedSchema = async (): Promise<void> => {
  logDebug("Migration", "Rebuilding wiped database from current schema");
  await executeBatch(
    fullSchemaCreateStatements().map((sql) => ({ args: [], sql })),
  );
  // A compound CREATE TRIGGER … BEGIN … END body carries internal semicolons
  // that batch transports mis-split, so triggers run one by one, exactly as
  // syncTriggers sends them.
  for (const trigger of TRIGGERS) {
    await runMigration(trigger.sql);
  }
  await sealFreshSchema();
};

const ensureMigrationTrackingTable = async (): Promise<void> => {
  await getDb().execute(
    createTableSql(SCHEMA.find(([name]) => name === SCHEMA_MIGRATIONS_TABLE)!),
  );
};

const getAppliedMigrationIds = async (): Promise<Set<string>> => {
  await ensureMigrationTrackingTable();
  const result = await getDb().execute(
    `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`,
  );
  return new Set(result.rows.map((row) => String(row.id)));
};

/** Build the INSERT that records a migration as applied. */
const migrationMarkerStatement = (
  migration: Migration,
  appliedAt: string,
): { sql: string; args: string[] } => ({
  args: [migration.id, migration.description, appliedAt],
  sql: `INSERT OR REPLACE INTO ${SCHEMA_MIGRATIONS_TABLE} (id, description, applied_at) VALUES (?, ?, ?)`,
});

const markMigrationApplied = async (migration: Migration): Promise<void> => {
  await ensureMigrationTrackingTable();
  await getDb().execute(migrationMarkerStatement(migration, nowIso()));
};

/**
 * Record several migrations as applied in one batch transaction — used by the
 * fresh-install and baseline paths, which mark every migration with no work in
 * between, so one round-trip replaces one per migration. Both callers only pass
 * a non-empty list (baseline returns early when nothing is missing).
 */
const markMigrationsApplied = async (
  migrations: Migration[],
): Promise<void> => {
  await ensureMigrationTrackingTable();
  const appliedAt = nowIso();
  await getDb().batch(
    migrations.map((migration) =>
      migrationMarkerStatement(migration, appliedAt),
    ),
    "write",
  );
};

const writeSchemaMarkers = async (): Promise<void> => {
  await getDb().execute({
    args: [LATEST_UPDATE],
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ?)",
  });
  await getDb().execute({
    args: [SCHEMA_HASH],
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('db_schema_hash', ?)",
  });
};

/** The migrations whose ids are not yet recorded as applied, in run order.
 *  Checks the ids first so the implementations only load when at least one
 *  migration is actually missing. */
const missingMigrations = async (): Promise<Migration[]> => {
  const applied = await getAppliedMigrationIds();
  if (MIGRATION_IDS.every((id) => applied.has(id))) return [];
  return (await loadMigrations()).filter(
    (migration) => !applied.has(migration.id),
  );
};

const baselineCurrentSchemaIfNeeded = async (): Promise<void> => {
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
        `verify ${migration.id} failed on attempt ${attempt + 1}, retrying: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
      `verify ${migration.id} still failing after retries, re-running up(): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await migration.up();
    await verifyMigrationWithRetry(migration);
  }
};

const runPendingMigrations = async (pending: Migration[]): Promise<void> => {
  for (const migration of pending) {
    logDebug("Migration", `Running ${migration.id}: ${migration.description}`);
    await applyMigrationWithRetry(migration);
    await markMigrationApplied(migration);
  }
};

/**
 * Stale markers with nothing pending happen two ways: a previous run was
 * killed after recording its migrations but before refreshing the markers
 * (verification passes — rewrite the markers), or SCHEMA was changed without
 * adding a named migration (verification fails — refuse to guess).
 */
const restoreStaleSchemaMarkers = async (): Promise<void> => {
  try {
    await verifyCurrentAppSchema();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Database schema markers are stale, no named migrations are pending, " +
        `and the live schema does not match (${detail}). ` +
        "Every SCHEMA change must ship with a new entry in MIGRATIONS.",
    );
  }
  logDebug("Migration", "Schema verified; restoring stale schema markers");
  await writeSchemaMarkers();
};

const MIGRATION_LOCK_KEY = "migration_lock";

/**
 * A migration lock older than this is treated as abandoned and stolen.
 * Migrations run inline on edge isolates that can be evicted mid-run,
 * orphaning the lock; the TTL lets the next boot self-heal instead of
 * requiring a manual DELETE FROM settings.
 */
export const MIGRATION_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * Acquire an advisory migration lock via the settings table.
 * Returns true if acquired, false if another process holds a fresh lock.
 * Stored values are ISO-8601 UTC timestamps, which sort lexicographically,
 * so a single atomic UPSERT both takes a free lock and steals an expired
 * one: DO UPDATE only fires when the held lock predates the cutoff, and a
 * fresh lock leaves rowsAffected at 0. Race-free across concurrent isolates
 * without a separate read.
 */
const acquireMigrationLock = async (
  allowMissingSettings: boolean,
): Promise<boolean> => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - MIGRATION_LOCK_TTL_MS).toISOString();
  const stamp = now.toISOString();
  const result = await getDb()
    .execute({
      args: [MIGRATION_LOCK_KEY, stamp, stamp, cutoff],
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
  return result === null || result.rowsAffected === 1;
};

/** Release the migration lock */
const releaseMigrationLock = async (): Promise<void> => {
  await runMigration(
    `DELETE FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
  );
};

type InitDbOptions = {
  /** Only setup/restore/bootstrap callers should create a missing settings table. */
  allowMissingSettings?: boolean;
};

// ─── Main migration ─────────────────────────────────────────────

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

const initDbUncached = async (allowMissingSettings: boolean): Promise<void> => {
  const probe = await probeDbState();
  if (await finishIfUpToDate(probe)) return;
  requireAllowedInitialDbState(probe.state, allowMissingSettings);

  const acquired = await acquireMigrationLock(allowMissingSettings);
  if (!acquired) {
    void sendNtfyError(`E_DB_MIGRATION_LOCK ${getEnv("DB_URL") ?? "unknown"}`);
    throw new MigrationInProgressError(
      "Database migration is already in progress (migration_lock held). " +
        `The request can be retried; a crashed migration's lock is reclaimed automatically after ${
          MIGRATION_LOCK_TTL_MS / 60000
        } minutes, or manually DELETE FROM settings WHERE key = 'migration_lock'.`,
    );
  }

  try {
    // Re-check after acquiring lock (another process may have finished)
    const recheck = await probeDbState();
    if (await finishIfUpToDate(recheck)) return;

    if (recheck.state === "missing_settings") {
      await initializeFreshSchema();
      return;
    }

    const pending = await missingMigrations();
    if (pending.length === 0) {
      await restoreStaleSchemaMarkers();
      return;
    }

    // Backups are no longer taken inline here: the Bunny edge subrequest budget
    // can't fit a full dump of a 31-table schema alongside the migration. They
    // run out-of-band instead — the upgrade GitHub Action backs each site up
    // first, and /admin/update + the per-site update button refuse to run
    // without a backup from the last hour (see hasRecentBackup).
    await runPendingMigrations(pending);

    logDebug("Migration", "Updating version marker...");
    await writeSchemaMarkers();
  } finally {
    // If the isolate is evicted mid-migration this finally will not run, so
    // stale locks are still reclaimed by MIGRATION_LOCK_TTL_MS.
    await releaseMigrationLock().catch((error) =>
      logDebug(
        "Migration",
        `Failed to release migration lock: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
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
  const client = getDb();
  try {
    for (const [name] of [...SCHEMA].reverse()) {
      await client.execute(`DROP TABLE IF EXISTS ${name}`);
    }
  } finally {
    clearAllCaches();
  }
};
