import { expect } from "@std/expect";
import { getDb } from "#db/client.ts";
import { acquireMigrationLock } from "#db/migrations/lock.ts";
import type {
  AdditiveMigration,
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "#db/migrations/types.ts";
import { invalidateInitDbCache, LATEST_UPDATE } from "#db/migrations.ts";
import { type SqlStatement, sql } from "#db/sql.ts";

/**
 * Stub used for every migration-context member a particular migration's `up()`
 * doesn't touch. `Promise<never>` so the same thrower satisfies both the void-
 * and boolean-returning members — the migration nominally asks for both, but a
 * single failing stub works for whichever it actually calls.
 */
export const unusedMigrationMember = async (): Promise<never> => {
  throw new Error("unused migration context member called");
};

/** True when a SQLite index with this name exists in the live test DB. Shared by
 *  the migration tests so the `sqlite_master` lookup lives in one place. */
export const indexExists = async (name: string): Promise<boolean> => {
  const result = await getDb().execute(
    sql`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ${name}`,
  );
  return result.rows.length > 0;
};

export const tableExists = async (table: string): Promise<boolean> => {
  const result = await getDb().execute(
    sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${table}`,
  );
  return result.rows.length > 0;
};

export const settingsTableExists = (): Promise<boolean> =>
  tableExists("settings");

/** The stored value of one settings row, or null when there is no such row. */
export const settingsValueOrNull = async (
  key: string,
): Promise<string | null> => {
  const result = await getDb().execute(
    sql`SELECT value FROM settings WHERE key = ${key}`,
  );
  return (result.rows[0]?.value as string) ?? null;
};

/** One column of a query's rows, as text, in the query's own order. */
const textColumn = async (
  statement: SqlStatement,
  column: string,
): Promise<string[]> => {
  const result = await getDb().execute(statement);
  return result.rows.map((row) => String(row[column]));
};

/** Every migration id the database has recorded as applied, in id order. */
export const appliedMigrationIds = (): Promise<string[]> =>
  textColumn(sql`SELECT id FROM schema_migrations ORDER BY id`, "id");

/**
 * A database last migrated at the previous release, with one migration still
 * pending. Without a LATEST_UPDATE bump beside a data migration, a site reads
 * up_to_date and baselines the migration id WITHOUT running its up().
 */
export const simulateUpgradeFromRelease = async (
  previousMarker: string,
  migrationId: string,
): Promise<void> => {
  expect(previousMarker).not.toBe(LATEST_UPDATE);
  await getDb().execute(
    sql`UPDATE settings SET value = ${previousMarker} WHERE key = 'latest_db_update'`,
  );
  await getDb().execute(
    sql`DELETE FROM schema_migrations WHERE id = ${migrationId}`,
  );
  invalidateInitDbCache();
};

/**
 * A lock stamp from long enough ago that no sane time limit still honours it.
 * Tests wanting an abandoned lock use this rather than working a date back from
 * the production limit, which would hide a change to the limit itself.
 */
export const LONG_EXPIRED_LOCK_STAMP = "2020-01-01T00:00:00.000Z";

/**
 * A lock stamp the time limit still honours — but not the same instant as the
 * acquisition under test, since two writes landing in one millisecond would
 * leave the limit untested.
 */
export const freshLockStamp = (): string =>
  new Date(Date.now() - 30_000).toISOString();

/** Take the migration lock for a test, failing loudly if another lease holds
 *  it — a test that cannot lock has nothing meaningful to assert. */
export const takeMigrationLock = async (): Promise<string> => {
  const lease = await acquireMigrationLock(false);
  if (lease === null) {
    throw new Error("Could not take the migration lock for this test");
  }
  return lease.token;
};

export const schemaMarkerKeys = (): Promise<string[]> =>
  textColumn(
    sql`SELECT key FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash') ORDER BY key`,
    "key",
  );

/** Assert the "empty but initialized settings table" state: settings table
 *  exists, listings table absent, no schema-version markers recorded yet. */
export const assertSchemaEmpty = async (): Promise<void> => {
  expect(await settingsTableExists()).toBe(true);
  expect(await tableExists("listings")).toBe(false);
  expect(await schemaMarkerKeys()).toEqual([]);
};

const additive = (migration: AdditiveMigration): Migration => ({
  ...migration,
  verify: async () => {},
});

const verifyRequirement = (_req: SchemaRequirement) => async () => {};

/**
 * Build a {@link MigrationContext} for a single-migration unit test.
 *
 * Each migration's `up()` only touches a handful of context members, all of
 * which come from `#shared/db/migrations/schema-sync.ts` in production. By
 * default every member except `getDb` throws, so a test fails loudly if its
 * migration reaches a member it shouldn't. Pass real implementations for just
 * the members the migration under test uses:
 *
 * ```ts
 * import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
 *
 * const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
 * ```
 *
 * `getDb` is always bound to the real client; override it only if a test needs
 * a different one.
 */
export const buildMigrationContext = (
  overrides: Partial<MigrationContext> = {},
): MigrationContext => ({
  additive,
  applySchemaChanges: unusedMigrationMember,
  backfillAnswerAggregates: unusedMigrationMember,
  backfillListingAggregates: unusedMigrationMember,
  backfillModifierAggregates: unusedMigrationMember,
  ensureDefaultAttendeeStatus: unusedMigrationMember,
  getDb,
  recreateTable: unusedMigrationMember,
  renameEventsToListings: unusedMigrationMember,
  syncCurrentSchema: unusedMigrationMember,
  syncIndexes: unusedMigrationMember,
  syncTriggers: unusedMigrationMember,
  tableExists: unusedMigrationMember,
  verifyCurrentAppSchema: unusedMigrationMember,
  verifyRequirement,
  ...overrides,
});
