/** Shared fixtures for sharded migration restore and historical chain tests. */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, insert } from "#shared/db/client.ts";
import { TRIGGERS } from "#shared/db/migrations/schema/triggers.ts";
import type { Trigger } from "#shared/db/migrations/schema/types.ts";
import { verifyCurrentAppSchema } from "#shared/db/migrations/schema-sync.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  loadMigrations,
  type Migration,
  SCHEMA_HASH,
  type SchemaRequirement,
} from "#shared/db/migrations.ts";
import { seedPreDropLedgerColumns } from "#test/test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createLegacyPaymentTables } from "#test-utils/legacy-payment-tables.ts";
import { indexExists } from "#test-utils/migrations.ts";
import {
  assertHistoricalFixtureSurvived,
  type HistoricalFixtureExpectations,
  seedHistoricalFixture,
} from "./historical-fixture.ts";

const MIGRATIONS = await loadMigrations();
export const migrationById = (id: string): Migration =>
  MIGRATIONS.find((m) => m.id === id)!;

// These migrations also enforce removed tables or exact index definitions.
const POST_CHAIN_MIGRATION_VERIFIER_IDS = [
  "2026-06-14_rename_events_to_listings",
  "2026-06-18_contact_preferences",
  "2026-06-23_attendee_order_parent",
  "2026-07-05_package_slot_identity",
  "2026-07-26_retire_legacy_payment_tables",
] as const;

const verifyMigratedSchema = async (): Promise<void> => {
  await verifyCurrentAppSchema();
  for (const id of POST_CHAIN_MIGRATION_VERIFIER_IDS) {
    await migrationById(id).verify();
  }
};

export const tableColumns = async (table: string): Promise<Set<string>> => {
  const result = await getDb().execute(
    `SELECT name FROM pragma_table_info('${table}')`,
  );
  return new Set(result.rows.map((row) => String(row.name)));
};

export const triggerExists = async (name: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [name],
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  });
  return result.rows.length > 0;
};

// Drop later explicit indexes before the historical column they reference.
const indexesReferencingColumn = async (
  table: string,
  column: string,
): Promise<string[]> => {
  const indexes = await getDb().execute({
    args: [table],
    sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
  });
  const names: string[] = [];
  for (const row of indexes.rows) {
    const name = String(row.name);
    const cols = await getDb().execute(
      `SELECT name FROM pragma_index_info('${name}')`,
    );
    if (cols.rows.some((c) => String(c.name) === column)) names.push(name);
  }
  return names;
};

const triggerIsOwnedBy =
  (req: SchemaRequirement, droppedTables: ReadonlySet<string>) =>
  (trigger: Trigger): boolean =>
    (req.triggers ?? []).includes(trigger.name) ||
    droppedTables.has(trigger.table) ||
    Object.entries(trigger.uses).some(
      ([table, columns]) =>
        droppedTables.has(table) ||
        columns.some((column) => req.columns?.[table]?.includes(column)),
    );

const dropRequiredColumns = async (
  columns: SchemaRequirement["columns"],
): Promise<void> => {
  for (const [table, cols] of Object.entries(columns ?? {})) {
    for (const col of cols) {
      // SQLite refuses the column drop while a later index still references it.
      for (const index of await indexesReferencingColumn(table, col)) {
        await getDb().execute(`DROP INDEX IF EXISTS ${index}`);
      }
      await getDb().execute(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    }
  }
};

// Drop owned objects in SQLite dependency order.
export const dropOwnedObjects = async (
  req: SchemaRequirement,
  triggers: readonly Trigger[] = TRIGGERS,
): Promise<Trigger[]> => {
  const droppedTables = new Set(req.newTables ?? []);
  const droppedTriggers = triggers.filter(triggerIsOwnedBy(req, droppedTables));
  const triggerNames = new Set([
    ...(req.triggers ?? []),
    ...droppedTriggers.map(({ name }) => name),
  ]);
  for (const trigger of triggerNames) {
    await getDb().execute(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const index of req.indexes ?? []) {
    await getDb().execute(`DROP INDEX IF EXISTS ${index}`);
  }
  await dropRequiredColumns(req.columns);
  for (const table of req.newTables ?? []) {
    await getDb().execute(`DROP TABLE IF EXISTS ${table}`);
  }
  return droppedTriggers;
};

export const seedSentinelListing = (): Promise<unknown> =>
  getDb().execute(
    insert("listings", {
      created: "2024-01-01T00:00:00Z",
      max_attendees: 10,
      name: "sentinel-listing",
    }),
  );

const PAYMENT_AGGREGATE_MIGRATION_ID = "2026-07-26_payment_aggregate";

const fixtureExpectations = (
  baseMigrationId: string,
): HistoricalFixtureExpectations => ({
  attendeeActivity:
    migrationIndex(baseMigrationId) >=
    migrationIndex("2026-06-14_attendee_statuses"),
  legacyPaymentReference:
    migrationIndex(baseMigrationId) >=
    migrationIndex("2026-07-07_processed_payments_payment_reference"),
  legacyPayments:
    migrationIndex(baseMigrationId) <
    migrationIndex(PAYMENT_AGGREGATE_MIGRATION_ID),
  modifierAggregates:
    migrationIndex(baseMigrationId) >= migrationIndex("2026-06-16_modifiers"),
});

const migrationIndex = (id: string): number =>
  MIGRATIONS.findIndex((migration) => migration.id === id);

export const sentinelListingExists = async (): Promise<boolean> => {
  const result = await getDb().execute(
    "SELECT 1 FROM listings WHERE name = 'sentinel-listing'",
  );
  return result.rows.length > 0;
};

const markAppliedThrough = async (lastAppliedId: string): Promise<void> => {
  const applied = MIGRATIONS.slice(
    0,
    MIGRATIONS.findIndex((migration) => migration.id === lastAppliedId) + 1,
  );
  await getDb().batch(
    [
      { args: [], sql: "DELETE FROM schema_migrations" },
      ...applied.map((migration) => ({
        args: [migration.id, migration.description],
        sql: "INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
      })),
      {
        args: [LATEST_UPDATE],
        sql: "UPDATE settings SET value = ? WHERE key = 'latest_db_update'",
      },
      {
        args: [SCHEMA_HASH],
        sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
      },
    ],
    "write",
  );
  invalidateInitDbCache();
};

const markSchemaMarkersStale = () =>
  getDb().batch(
    [
      "UPDATE settings SET value = 'stale' WHERE key = 'latest_db_update'",
      "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
    ],
    "write",
  );

// A migration is restore-testable only if it owns concrete schema objects to
// drop and rebuild; a data-only migration (empty `requires`, e.g. a ledger
// backfill) owns nothing, so dropping "its objects" is a no-op and verify()
// could never fail — it is covered by its own data test instead.
export const ownsSchemaObjects = (req: SchemaRequirement): boolean =>
  Boolean(
    req.newTables?.length ||
      req.indexes?.length ||
      req.triggers?.length ||
      Object.values(req.columns ?? {}).some((cols) => cols.length > 0),
  );

const columnsRemovedByMigration: Partial<Record<string, string[]>> = {
  "2026-07-05_first_class_images": [
    "ALTER TABLE listings ADD COLUMN image_url TEXT NOT NULL DEFAULT ''",
  ],
  "2026-07-18_drop_built_sites_last_pruned": [
    "ALTER TABLE built_sites ADD COLUMN last_pruned TEXT NOT NULL DEFAULT ''",
  ],
};

/** Wind the live schema back to just before these migrations ran. */
export const restoreSchemaBeforeMigrations = async (
  migrations: Migration[],
): Promise<void> => {
  if (
    migrations.some(
      (migration) => migration.id === PAYMENT_AGGREGATE_MIGRATION_ID,
    )
  ) {
    await createLegacyPaymentTables(getDb);
  }
  for (const migration of [...migrations].reverse()) {
    if (
      migration.requires &&
      !migration.requires.absentTables &&
      ownsSchemaObjects(migration.requires)
    ) {
      await dropOwnedObjects(migration.requires);
    }
  }
  for (const migration of migrations) {
    for (const statement of columnsRemovedByMigration[migration.id] ?? []) {
      await getDb().execute(statement);
    }
  }
};

// Additive migrations own concrete objects and can be reconstructed by
// re-running up(). The baseline reconcile (no `requires`), migrations that
// remove legacy tables, and data-only migrations are covered separately.
export const additiveMigrations = MIGRATIONS.filter(
  (m) =>
    m.requires &&
    !m.requires.absentTables &&
    ![
      "2026-06-12_sumup_checkouts",
      "2026-06-16_processed_payments_failure_data",
      "2026-07-07_processed_payments_payment_reference",
      "2026-07-10_processed_payments_attendee_index",
      "2026-07-15_checkout_stages",
    ].includes(m.id) &&
    ownsSchemaObjects(m.requires),
);

/** The historical upgrade start points the chain suites migrate from. */
export const migrationBoundaries = MIGRATIONS.slice(
  MIGRATIONS.findIndex((m) => m.id === "2026-06-14_rename_events_to_listings"),
  -1,
);

/** Keeps only the entries a shard owns: every `shardCount`-th, offset `shard`. */
const shardSlice = <T>(items: T[], shard: number, shardCount: number): T[] =>
  items.filter((_, index) => index % shardCount === shard);

/**
 * Spot-check that every object a migration declares it owns is present in the
 * live schema again after a drop/restore cycle.
 */
const assertOwnedObjectsPresent = async (
  req: SchemaRequirement,
): Promise<void> => {
  for (const table of req.newTables ?? []) {
    expect((await tableColumns(table)).size).toBeGreaterThan(0);
  }
  for (const [table, cols] of Object.entries(req.columns ?? {})) {
    const present = await tableColumns(table);
    for (const col of cols) expect(present.has(col)).toBe(true);
  }
  for (const index of req.indexes ?? []) {
    expect(await indexExists(index)).toBe(true);
  }
  for (const trigger of req.triggers ?? []) {
    expect(await triggerExists(trigger)).toBe(true);
  }
};

/**
 * Register one shard of the per-migration restore suite: for each additive
 * migration in the shard, drop exactly its owned objects, prove verify()
 * fails, re-run up(), and prove verify() passes with pre-existing data intact.
 */
export const defineRestoreCasesSuite = (
  shard: number,
  shardCount: number,
): void => {
  describeWithEnv(
    `db > migration restore (shard ${shard + 1}/${shardCount})`,
    { db: true, triggers: true },
    () => {
      for (const migration of shardSlice(
        additiveMigrations,
        shard,
        shardCount,
      )) {
        const req = migration.requires!;

        test(`restores ${migration.id} after its objects are dropped`, async () => {
          await seedSentinelListing();

          // Precondition: a freshly-migrated DB satisfies the migration.
          await migration.verify();

          const droppedTriggers = await dropOwnedObjects(req);

          // With its objects gone, the migration's verify() must fail.
          await expect(migration.verify()).rejects.toThrow(
            "Migration verification failed",
          );

          // Re-running up() restores exactly those objects...
          await migration.up();
          for (const trigger of droppedTriggers) {
            await getDb().execute(trigger.sql);
          }
          await migration.verify();

          // ...and the row that existed before the drop/restore is untouched.
          expect(await sentinelListingExists()).toBe(true);

          // Spot-check that each declared object is actually present again.
          await assertOwnedObjectsPresent(req);
        });
      }
    },
  );
};

/**
 * Register one shard of the populated-database chain suite: for each boundary
 * in the shard, seed a populated fixture, wind the schema back to that
 * boundary, run the real `initDb()` upgrade, and prove every migration
 * verifies and the fixture survived.
 */
export const defineChainSuite = (shard: number, shardCount: number): void => {
  describeWithEnv(
    `db > migration chain (shard ${shard + 1}/${shardCount})`,
    { db: true, triggers: true },
    () => {
      for (const baseMigration of shardSlice(
        migrationBoundaries,
        shard,
        shardCount,
      )) {
        test(`migrates a populated database from ${baseMigration.id} to the current schema`, async () => {
          const expected = fixtureExpectations(baseMigration.id);
          await seedHistoricalFixture(expected.legacyPayments);
          // The fixture is built from the current (post-drop) schema, but the
          // 2026-06-22_backfill_transfers migration in the chain reads
          // listing_attendees.refunded and price_paid — present in production until
          // the later drop_listing_attendee_refunded / drop_listing_attendee_price_paid
          // migrations recreate the table without them. Restore the columns so the
          // chain reproduces production; the drop migrations then remove them again,
          // leaving the verified schema correct.
          await seedPreDropLedgerColumns();

          const pending = MIGRATIONS.slice(
            MIGRATIONS.indexOf(baseMigration) + 1,
          );
          await restoreSchemaBeforeMigrations(pending);

          await markAppliedThrough(baseMigration.id);
          await markSchemaMarkersStale();

          await initDb();

          await verifyMigratedSchema();
          await assertHistoricalFixtureSurvived(expected);
        });
      }
    },
  );
};
