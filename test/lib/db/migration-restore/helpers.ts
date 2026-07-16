/**
 * Shared fixture for the migration restore/chain suites.
 *
 * "Restore from each migration" — for every additive migration, start from a
 * fully-migrated database, drop exactly the objects that migration owns, prove
 * its verify() now fails, then re-run its up() and prove verify() passes again
 * and that pre-existing data survived. The chain suites do the larger version:
 * migrate a populated database from every historical boundary to the current
 * schema through the real `initDb()`.
 *
 * Both suites are sharded across several test files via the `defineRestore…` /
 * `defineChain…` factories below (shard by index modulo shard count), so
 * `deno test --parallel` can spread this genuinely heavy DDL work across
 * workers instead of serialising ~2 minutes of it on one. Modulo sharding
 * keeps the shards balanced as migrations are added — each shard gets an even
 * mix of long (old boundary) and short (recent boundary) chains.
 */
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
import { describeWithEnv } from "#test-utils/db.ts";
import { indexExists } from "#test-utils/migrations.ts";
import { seedPreDropLedgerColumns } from "../migration-test-helpers.ts";

const MIGRATIONS = await loadMigrations();
export const migrationById = (id: string): Migration =>
  MIGRATIONS.find((m) => m.id === id)!;

// Current-schema verification covers ordinary migrations. These four also
// enforce removed legacy tables or the exact booking-slot index definition.
const POST_CHAIN_MIGRATION_VERIFIER_IDS = [
  "2026-06-14_rename_events_to_listings",
  "2026-06-18_contact_preferences",
  "2026-06-23_attendee_order_parent",
  "2026-07-05_package_slot_identity",
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

// Explicitly-created indexes (sql IS NOT NULL excludes the auto-indexes backing
// UNIQUE/PK constraints) on `table` that include `column` — possibly declared
// by a LATER migration than the one that added the column. SQLite refuses
// DROP COLUMN while any index references it, so the restore drops these first.
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

// Drop a migration's owned objects in an order SQLite accepts: triggers and
// indexes first (a column can't be dropped while a trigger or index
// references it), then the columns added to existing tables, then the tables
// the migration created.
export const dropOwnedObjects = async (
  req: SchemaRequirement,
  triggers: readonly Trigger[] = TRIGGERS,
): Promise<Trigger[]> => {
  const droppedTables = new Set(req.newTables ?? []);
  const droppedTriggers = triggers.filter(
    (trigger) =>
      (req.triggers ?? []).includes(trigger.name) ||
      droppedTables.has(trigger.table) ||
      Object.entries(trigger.uses).some(
        ([table, columns]) =>
          droppedTables.has(table) ||
          columns.some((column) => req.columns?.[table]?.includes(column)),
      ),
  );
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
  for (const [table, cols] of Object.entries(req.columns ?? {})) {
    for (const col of cols) {
      // A later migration may index this column (e.g.
      // idx_listing_attendees_ledger_event_group on ledger_event_group); drop
      // any such index before the column, or SQLite refuses the DROP COLUMN.
      for (const index of await indexesReferencingColumn(table, col)) {
        await getDb().execute(`DROP INDEX IF EXISTS ${index}`);
      }
      await getDb().execute(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    }
  }
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

export const scalar = async (sql: string): Promise<unknown> => {
  const result = await getDb().execute(sql);
  return result.rows[0]?.value;
};

const seedPopulatedMigrationFixture = () =>
  getDb().batch(
    [
      `INSERT INTO groups (id, slug, slug_index, name, description, max_attendees)
       VALUES (901, 'migration-group', 'group-index', 'Migration Group', 'historic group', 50)`,
      `INSERT INTO listings (id, created, max_attendees, name, slug, slug_index, unit_price, max_quantity, listing_type, date, location, customisable_days, uses_logistics)
       VALUES (902, '2024-01-01T00:00:00Z', 25, 'migration-listing', 'migration-listing', 'listing-index', 1200, 4, 'standard', '2024-02-01', 'Town Hall', 1, 1)`,
      `INSERT INTO attendees (id, created, checked_in, ticket_token_index, pii_blob, status_id, split_logistics_agents, phone_index)
       VALUES (903, '2024-01-02T00:00:00Z', '', 'ticket-index', '{"name":"Migration Guest"}', 1, 1, 'phone-index')`,
      `INSERT INTO listing_attendees (id, listing_id, attendee_id, start_at, end_at, quantity, checked_in, start_agent_id, end_agent_id, start_time, end_time, start_done, end_done)
       VALUES (904, 902, 903, '2024-02-01T10:00:00Z', '2024-02-01T12:00:00Z', 2, 1, NULL, NULL, '10:00', '12:00', 1, 0)`,
      `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, ticket_tokens, failure_data)
       VALUES ('payment-session', 903, '2024-01-02T00:10:00Z', 'ticket-token', '{"code":"card_declined"}')`,
      `INSERT INTO activity_log (id, created, listing_id, message, attendee_id)
       VALUES (905, '2024-01-02T00:15:00Z', 902, 'fixture activity', 903)`,
      `INSERT INTO sumup_checkouts (reference_index, wrapped_key, metadata, sumup_id, created_at)
       VALUES ('sumup-reference', 'wrapped', '{"attendeeId":903}', 'sumup-id', '2024-01-02T00:20:00Z')`,
      `INSERT INTO questions (id, text, sort_order, display_type, assign_all)
       VALUES (906, 'Meal choice?', 7, 'select', 1)`,
      `INSERT INTO modifiers (id, name, calc_kind, calc_value, direction, active, trigger, code, code_index, scope, stock, max_per_order, min_subtotal, min_visits)
       VALUES (907, 'VIP uplift', 'fixed', 5, 'increase', 1, 'answer', '', NULL, 'listing', 20, 2, 1000, 1)`,
      `INSERT INTO answers (id, question_id, text, sort_order, modifier_id)
       VALUES (908, 906, 'Vegetarian', 3, 907)`,
      `INSERT INTO listing_questions (id, listing_id, question_id, sort_order)
       VALUES (909, 902, 906, 4)`,
      `INSERT INTO attendee_answers (id, attendee_id, answer_id, question_id)
       VALUES (910, 903, 908, 906)`,
      `INSERT INTO modifier_listings (modifier_id, listing_id)
       VALUES (907, 902)`,
      `INSERT INTO modifier_groups (modifier_id, group_id)
       VALUES (907, 901)`,
      `INSERT INTO modifier_usages (id, modifier_id, attendee_id, quantity, amount_applied, created)
       VALUES (911, 907, 903, 2, 500, '2024-01-02T00:25:00Z')`,
      `INSERT INTO holidays (id, name, start_date, end_date)
       VALUES (912, 'Fixture holiday', '2024-03-01', '2024-03-03')`,
      `INSERT INTO built_sites (id, site_data, assignable, assigned_attendee_id, assigned_listing_id, created, renewal_token_index, read_only_from)
       VALUES (913, '{"site":"fixture"}', 1, 903, 902, '2024-01-03T00:00:00Z', 'renewal-index', '')`,
      `INSERT INTO email_templates (id, subject, body)
       VALUES (914, 'Fixture subject', 'Fixture body')`,
      `INSERT INTO sms_messages (id, attendee_id, listing_id, provider_id, created)
       VALUES (915, 903, 902, 'provider-message', '2024-01-03T00:05:00Z')`,
      `INSERT INTO processed_sms_inbound (webhook_id, created)
       VALUES ('sms-webhook', '2024-01-03T00:06:00Z')`,
      `INSERT INTO contact_preferences (contact_hash, unsubscribed, visits, stats_blob, last_activity)
       VALUES ('contact-hash', 1, 5, '{}', 1700000000)`,
    ],
    "write",
  );

const migrationIndex = (id: string): number =>
  MIGRATIONS.findIndex((migration) => migration.id === id);

const assertPopulatedFixtureSurvived = async (
  baseMigrationId: string,
): Promise<void> => {
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM listings WHERE id = 902 AND name = 'migration-listing' AND booked_quantity = 2 AND tickets_count = 1",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM listing_attendees WHERE id = 904 AND listing_id = 902 AND attendee_id = 903 AND quantity = 2",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM attendees WHERE id = 903 AND ticket_token_index = 'ticket-index'",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND listing_id = 902 AND message = 'fixture activity'",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM groups WHERE id = 901 AND slug_index = 'group-index'",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM built_sites WHERE id = 913 AND assigned_listing_id = 902 AND assigned_attendee_id = 903",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM questions WHERE id = 906 AND text = 'Meal choice?'",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM answers WHERE id = 908 AND question_id = 906 AND times_selected = 1",
    ),
  ).toBe(1);
  expect(
    await scalar(
      "SELECT COUNT(*) AS value FROM attendee_answers WHERE id = 910 AND attendee_id = 903 AND answer_id = 908",
    ),
  ).toBe(1);

  if (
    migrationIndex(baseMigrationId) >=
    migrationIndex("2026-06-14_attendee_statuses")
  ) {
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM activity_log WHERE id = 905 AND attendee_id = 903",
      ),
    ).toBe(1);
  }

  if (
    migrationIndex(baseMigrationId) >= migrationIndex("2026-06-16_modifiers")
  ) {
    // total_revenue is no longer a stored column — a modifier's revenue
    // projects from the transfers ledger as balanceOf(modifier:M). The
    // fixture posts no modifier ledger legs, so only the count aggregates
    // (trigger-maintained) survive here.
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM modifiers WHERE id = 907 AND total_uses = 2 AND usage_count = 1",
      ),
    ).toBe(1);
    expect(
      await scalar(
        "SELECT COUNT(*) AS value FROM modifier_usages WHERE id = 911 AND modifier_id = 907 AND attendee_id = 903",
      ),
    ).toBe(1);
  }
};

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

// Additive migrations own concrete objects and can be reconstructed by
// re-running up(). The baseline reconcile (no `requires`), migrations that
// remove legacy tables, and data-only migrations are covered separately.
export const additiveMigrations = MIGRATIONS.filter(
  (m) =>
    m.requires && !m.requires.absentTables && ownsSchemaObjects(m.requires),
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
          await seedPopulatedMigrationFixture();
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
          for (const migration of [...pending].reverse()) {
            if (
              migration.requires &&
              !migration.requires.absentTables &&
              ownsSchemaObjects(migration.requires)
            ) {
              await dropOwnedObjects(migration.requires);
            }
          }

          await markAppliedThrough(baseMigration.id);
          await markSchemaMarkersStale();

          await initDb();

          await verifyMigratedSchema();
          await assertPopulatedFixtureSurvived(baseMigration.id);
        });
      }
    },
  );
};
