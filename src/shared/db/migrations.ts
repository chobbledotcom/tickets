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
import { lazyRef } from "#fp";
import { ensureDefaultAttendeeStatus } from "#shared/db/attendee-statuses.ts";
import { getDb } from "#shared/db/client.ts";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateHolidaysCache } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";
import { invalidateLogisticsAgentsCache } from "#shared/db/logistics-agents.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { getEnv } from "#shared/env.ts";
import { logDebug } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { retryWithBackoff } from "#shared/retry.ts";
import { recordScriptVersion } from "#shared/update.ts";
import currentSchemaMigration from "./migrations/2026-06-11_current_schema.ts";
import sumupCheckoutsMigration from "./migrations/2026-06-12_sumup_checkouts.ts";
import eventAttendeesOverlapIndexMigration from "./migrations/2026-06-13_event_attendees_overlap_index.ts";
import attendeeStatusesMigration from "./migrations/2026-06-14_attendee_statuses.ts";
import emailPreferencesMigration from "./migrations/2026-06-14_email_preferences.ts";
import listingCustomisableDaysMigration from "./migrations/2026-06-14_listing_customisable_days.ts";
import questionSortOrderMigration from "./migrations/2026-06-14_question_sort_order.ts";
import renameEventsToListingsMigration, {
  EVENT_TO_LISTING_RENAME_PLAN,
} from "./migrations/2026-06-14_rename_events_to_listings.ts";
import activityLogListingIdIndexMigration from "./migrations/2026-06-15_activity_log_listing_id_index.ts";
import agentUsersMigration from "./migrations/2026-06-16_agent_users.ts";
import attendeePhoneIndexMigration from "./migrations/2026-06-16_attendee_phone_index.ts";
import emailTemplatesMigration from "./migrations/2026-06-16_email_templates.ts";
import listingAggregatesMigration from "./migrations/2026-06-16_listing_aggregates.ts";
import logisticsAgentsMigration from "./migrations/2026-06-16_logistics_agents.ts";
import modifiersMigration from "./migrations/2026-06-16_modifiers.ts";
import processedPaymentsFailureDataMigration from "./migrations/2026-06-16_processed_payments_failure_data.ts";
import smsMessagesMigration from "./migrations/2026-06-16_sms_messages.ts";
import modifierAggregatesMigration from "./migrations/2026-06-17_modifier_aggregates.ts";
import modifierCodeMigration from "./migrations/2026-06-17_modifier_code.ts";
import processedSmsInboundMigration from "./migrations/2026-06-17_processed_sms_inbound.ts";
import answerModifiersMigration from "./migrations/2026-06-18_answer_modifiers.ts";
import contactPreferencesMigration from "./migrations/2026-06-18_contact_preferences.ts";
import modifierMinVisitsMigration from "./migrations/2026-06-18_modifier_min_visits.ts";
import questionAssignAllMigration from "./migrations/2026-06-18_question_assign_all.ts";
import questionDisplayTypeMigration from "./migrations/2026-06-18_question_display_type.ts";
import answerAggregatesMigration from "./migrations/2026-06-19_answer_aggregates.ts";
import builtSitesLastPrunedMigration from "./migrations/2026-06-19_built_sites_last_pruned.ts";
import answerActiveMigration from "./migrations/2026-06-20_answer_active.ts";
import contactBookingCountsMigration from "./migrations/2026-06-20_contact_booking_counts.ts";
import freeTextQuestionsMigration from "./migrations/2026-06-20_free_text_questions.ts";
import stringCreatedMigration from "./migrations/2026-06-20_string_created.ts";
import userKekV2Migration from "./migrations/2026-06-20_user_kek_v2.ts";
import transfersMigration from "./migrations/2026-06-21_transfers.ts";
import backfillTransfersMigration from "./migrations/2026-06-22_backfill_transfers.ts";
import dropAttendeesPricePaidMigration from "./migrations/2026-06-22_drop_attendees_price_paid.ts";
import dropAttendeesRemainingBalanceMigration from "./migrations/2026-06-22_drop_attendees_remaining_balance.ts";
import dropListingAttendeePricePaidMigration from "./migrations/2026-06-22_drop_listing_attendee_price_paid.ts";
import dropListingAttendeeRefundedMigration from "./migrations/2026-06-22_drop_listing_attendee_refunded.ts";
import dropListingIncomeMigration from "./migrations/2026-06-22_drop_listing_income.ts";
import dropModifiersTotalRevenueMigration from "./migrations/2026-06-22_drop_modifiers_total_revenue.ts";
import dropTransfersCurrencyMigration from "./migrations/2026-06-22_drop_transfers_currency.ts";
import listingAttendeeLedgerEventGroupMigration from "./migrations/2026-06-22_listing_attendee_ledger_event_group.ts";
import transfersTimeIntMigration from "./migrations/2026-06-22_transfers_time_int.ts";
import systemNotesMigration from "./migrations/2026-06-23_system_notes.ts";
import ticketCountNoQuantityMigration from "./migrations/2026-06-23_ticket_count_no_quantity.ts";
import builtSitesUpdatesMigration from "./migrations/2026-06-24_built_sites_updates.ts";
import listingAttendeeLedgerEventGroupIndexMigration from "./migrations/2026-06-25_listing_attendee_ledger_event_group_index.ts";
import { repairLegacyRenames } from "./migrations/rename-utils.ts";
import {
  LATEST_UPDATE,
  SCHEMA,
  SCHEMA_HASH,
  SCHEMA_MIGRATIONS_TABLE,
} from "./migrations/schema.ts";
import {
  applySchemaChanges,
  backfillAnswerAggregates,
  backfillListingAggregates,
  backfillModifierAggregates,
  createTableSql,
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

const isMissingSettingsTableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:?\s*(\w+\.)?settings\b/i.test(message);
};

/** Check database state: up-to-date, needs migration, or missing settings table */
const getDbState = async (): Promise<DbState> => {
  try {
    const result = await getDb().execute(
      "SELECT key, value FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash')",
    );
    if (result.rows.length === 0) return "uninitialized_settings";
    const values = new Map(
      result.rows.map((r) => [r.key as string, r.value as string]),
    );
    return values.get("latest_db_update") === LATEST_UPDATE &&
      values.get("db_schema_hash") === SCHEMA_HASH
      ? "up_to_date"
      : "needs_migration";
  } catch (error) {
    if (isMissingSettingsTableError(error)) return "missing_settings";
    throw error;
  }
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

export const MIGRATIONS: Migration[] = [
  currentSchemaMigration,
  sumupCheckoutsMigration,
  eventAttendeesOverlapIndexMigration,
  renameEventsToListingsMigration,
  questionSortOrderMigration,
  emailPreferencesMigration,
  listingCustomisableDaysMigration,
  attendeeStatusesMigration,
  activityLogListingIdIndexMigration,
  logisticsAgentsMigration,
  emailTemplatesMigration,
  agentUsersMigration,
  processedPaymentsFailureDataMigration,
  listingAggregatesMigration,
  modifiersMigration,
  modifierCodeMigration,
  smsMessagesMigration,
  processedSmsInboundMigration,
  attendeePhoneIndexMigration,
  modifierAggregatesMigration,
  contactPreferencesMigration,
  modifierMinVisitsMigration,
  questionDisplayTypeMigration,
  answerModifiersMigration,
  questionAssignAllMigration,
  answerAggregatesMigration,
  builtSitesLastPrunedMigration,
  freeTextQuestionsMigration,
  stringCreatedMigration,
  answerActiveMigration,
  contactBookingCountsMigration,
  userKekV2Migration,
  transfersMigration,
  transfersTimeIntMigration,
  dropTransfersCurrencyMigration,
  listingAttendeeLedgerEventGroupMigration,
  backfillTransfersMigration,
  dropListingIncomeMigration,
  dropListingAttendeeRefundedMigration,
  dropListingAttendeePricePaidMigration,
  dropAttendeesPricePaidMigration,
  dropAttendeesRemainingBalanceMigration,
  dropModifiersTotalRevenueMigration,
  systemNotesMigration,
  // Runs after drop_listing_income so the trigger rebuild lands on top of the
  // income-free bodies: re-counts tickets_count as quantity > 0 only.
  ticketCountNoQuantityMigration,
  builtSitesUpdatesMigration,
  // Pure index add (idempotent CREATE INDEX IF NOT EXISTS via syncIndexes);
  // order-independent, appended last.
  listingAttendeeLedgerEventGroupIndexMigration,
].map((build) => build(migrationContext));

export const MIGRATION_IDS: string[] = MIGRATIONS.map(
  (migration) => migration.id,
);

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
  await ensureDefaultAttendeeStatus();
  await syncTriggers();
  await writeSchemaMarkers();
  await markMigrationsApplied(MIGRATIONS);
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

const baselineCurrentSchemaIfNeeded = async (): Promise<void> => {
  const applied = await getAppliedMigrationIds();
  const missing = MIGRATIONS.filter((migration) => !applied.has(migration.id));
  if (missing.length === 0) return;

  await verifyCurrentAppSchema();
  logDebug(
    "Migration",
    `Baselining ${missing.length} already-applied migration(s)`,
  );
  await markMigrationsApplied(missing);
};

const pendingMigrations = async (): Promise<Migration[]> => {
  const applied = await getAppliedMigrationIds();
  return MIGRATIONS.filter((migration) => !applied.has(migration.id));
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
        `verify ${migration.id} failed on attempt ${
          attempt + 1
        }, retrying: ${error instanceof Error ? error.message : String(error)}`,
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
  await recordScriptVersion();
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

const initDbUncached = async (allowMissingSettings: boolean): Promise<void> => {
  let state = await getDbState();
  if (state === "up_to_date") {
    await baselineCurrentSchemaIfNeeded();
    return;
  }
  requireAllowedInitialDbState(state, allowMissingSettings);

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
    state = await getDbState();
    if (state === "up_to_date") {
      await baselineCurrentSchemaIfNeeded();
      return;
    }

    if (state === "missing_settings") {
      await initializeFreshSchema();
      return;
    }

    const pending = await pendingMigrations();
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
    // Clear all module-level caches — even if a DROP fails partway through,
    // stale caches must not let subsequent requests bypass not-activated
    // handling or serve pre-reset data.
    invalidateInitDbCache();
    settings.invalidateCache();
    settings.setup.clearCache();
    resetSessionCache();
    invalidateUsersCache();
    invalidateListingsCache();
    invalidateHolidaysCache();
    invalidateGroupsCache();
    invalidateLogisticsAgentsCache();
  }
};
