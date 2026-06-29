import { expect } from "@std/expect";
import { getDb } from "#shared/db/client.ts";
import type {
  AdditiveMigration,
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "#shared/db/migrations/types.ts";

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
  const result = await getDb().execute({
    args: [name],
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
  });
  return result.rows.length > 0;
};

export const tableExists = async (table: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [table],
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
  });
  return result.rows.length > 0;
};

export const settingsTableExists = (): Promise<boolean> =>
  tableExists("settings");

export const schemaMarkerKeys = async (): Promise<string[]> => {
  const result = await getDb().execute(
    "SELECT key FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash') ORDER BY key",
  );
  return result.rows.map((row) => String(row.key));
};

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
 * import { applySchemaChanges, syncIndexes } from "#shared/db/migrations/schema-sync.ts";
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
