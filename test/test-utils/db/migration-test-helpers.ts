import type { ResultSet } from "@libsql/client";
import { assert, assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, getDb, queryBatch } from "#db/client.ts";
import { initDb, invalidateInitDbCache } from "#db/migrations.ts";
import {
  type SqlStatement,
  sql,
  sqlLiteral,
  sqlName,
  sqlNames,
} from "#db/sql.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** Run many statements as a single batched write round-trip. */
export const executeStatements = (
  statements: readonly SqlStatement[],
): Promise<void> => executeBatch([...statements]);

/** A read statement paired with a label, so a batch's results can be read by
 *  name instead of by position. */
type LabelledStatement = { label: string; statement: SqlStatement };

const queryLabelledBatch = async (
  statements: readonly LabelledStatement[],
): Promise<Map<string, ResultSet>> => {
  const results = await queryBatch(statements.map((stmt) => stmt.statement));
  return new Map(statements.map((stmt, i) => [stmt.label, results[i]!]));
};

export type SchemaRenameStep =
  | { kind: "table"; from: string; to: string }
  | { kind: "column"; table: string; from: string; to: string };

export const renameTableStep = (
  from: string,
  to: string,
): SchemaRenameStep => ({ from, kind: "table", to });

export const renameColumnStep = (
  table: string,
  from: string,
  to: string,
): SchemaRenameStep => ({ from, kind: "column", table, to });

const renameStepSql = (step: SchemaRenameStep): SqlStatement =>
  step.kind === "table"
    ? sql`ALTER TABLE ${sqlName(step.from)} RENAME TO ${sqlName(step.to)}`
    : sql`ALTER TABLE ${sqlName(step.table)} RENAME COLUMN ${sqlName(step.from)} TO ${sqlName(step.to)}`;

export const applySchemaRenameSteps = (steps: readonly SchemaRenameStep[]) =>
  getDb().batch(steps.map(renameStepSql), "write");

export const LISTING_TO_LEGACY_EVENT_RENAME_STEPS: readonly SchemaRenameStep[] =
  [
    renameColumnStep("listings", "listing_type", "event_type"),
    renameTableStep("listings", "events"),
    renameColumnStep("listing_attendees", "listing_id", "event_id"),
    renameTableStep("listing_attendees", "event_attendees"),
    renameColumnStep("listing_questions", "listing_id", "event_id"),
    renameTableStep("listing_questions", "event_questions"),
    renameColumnStep("activity_log", "listing_id", "event_id"),
    renameColumnStep("built_sites", "assigned_listing_id", "assigned_event_id"),
  ];

export const downgradeListingDomainToLegacyNames = () =>
  applySchemaRenameSteps(LISTING_TO_LEGACY_EVENT_RENAME_STEPS);

export const markCurrentSchemaMigrationPending = () => {
  // Clearing recorded history must also clear the per-isolate ready cache,
  // otherwise initDb never re-inspects this client.
  invalidateInitDbCache();
  return getDb().execute(sql`DROP TABLE IF EXISTS schema_migrations`);
};

export const markMigrationsForRerun = async (): Promise<void> => {
  await executeStatements([
    sql`DROP TABLE IF EXISTS schema_migrations`,
    sql`UPDATE settings SET value = 'stale' WHERE key IN ('latest_db_update', 'db_schema_hash')`,
  ]);
  invalidateInitDbCache();
};

export const schemaHashMarker = async (): Promise<unknown> => {
  const result = await getDb().execute(
    sql`SELECT value FROM settings WHERE key = 'db_schema_hash'`,
  );
  return result.rows[0]?.value;
};

export const seedListingDomainRows = async (): Promise<number> => {
  const listing = await createTestListing();
  await executeBatch([
    sql`INSERT INTO listing_attendees (listing_id, attendee_id) VALUES (${listing.id}, ${999})`,
    sql`INSERT INTO listing_questions (listing_id, question_id) VALUES (${listing.id}, ${999})`,
    sql`INSERT INTO activity_log (created, listing_id, message) VALUES ('2024-01-01T00:00:00Z', ${listing.id}, 'legacy listing activity')`,
    sql`INSERT INTO built_sites (site_data, assigned_listing_id, created) VALUES ('{}', ${listing.id}, '2024-01-01T00:00:00Z')`,
  ]);
  return listing.id;
};

/**
 * Recreate the legacy `listing_attendees.refunded` and `price_paid` columns on a
 * test database built from the current (post-drop) SCHEMA. The
 * `2026-06-22_backfill_transfers` migration reads both columns, and it runs
 * BEFORE the `2026-06-22_drop_listing_attendee_refunded` /
 * `2026-06-22_drop_listing_attendee_price_paid` migrations remove them — so
 * production still has the columns when the backfill runs. Fixtures that build
 * from the current schema must restore them first to reproduce the schema the
 * backfill really runs against (the drop migrations remove them again, leaving
 * the final schema correct).
 */
export const seedPreDropLedgerColumns = (): Promise<void> =>
  executeStatements([
    sql`ALTER TABLE listing_attendees ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0`,
    sql`ALTER TABLE listing_attendees ADD COLUMN price_paid INTEGER NOT NULL DEFAULT 0`,
  ]);

/**
 * Stamp a pre-ledger booking row's `price_paid` — the column the backfill reads
 * to reconstruct a historical `sale` leg. Production's booking insert no longer
 * writes it, so a backfill test that wants the migration to see a paid booking
 * sets it directly (on the column restored by {@link seedPreDropLedgerColumns}).
 */
export const stampHistoricalPricePaid = (
  attendeeId: number,
  listingId: number,
  amount: number,
): Promise<unknown> =>
  getDb().execute(
    sql`UPDATE listing_attendees SET price_paid = ${amount} WHERE attendee_id = ${attendeeId} AND listing_id = ${listingId}`,
  );

export const columnNames = async (table: string): Promise<string[]> => {
  const result = await getDb().execute(
    sql`SELECT name FROM pragma_table_info(${sqlLiteral(table)})`,
  );
  return result.rows.map((row) => String(row.name));
};

export const tableNames = async (): Promise<Set<string>> => {
  const result = await getDb().execute(
    sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
  );
  return new Set(result.rows.map((row) => String(row.name)));
};

export const tableRowCount = async (table: string): Promise<number> => {
  const result = await getDb().execute(
    sql`SELECT COUNT(*) AS n FROM ${sqlName(table)}`,
  );
  return Number(result.rows[0]!.n);
};

/** A reader of the count columns that a table's triggers maintain, by row id. */
const countColumnsReader =
  (table: string, columns: readonly string[]) =>
  async (id: number): Promise<Record<string, number>> => {
    const result = await getDb().execute(
      sql`SELECT ${sqlNames(columns)} FROM ${sqlName(table)} WHERE id = ${id}`,
    );
    const row = result.rows[0]!;
    return Object.fromEntries(
      columns.map((column) => [column, Number(row[column])]),
    );
  };

/** Read `total_uses` and `usage_count` for a modifier: the two columns that
 * the modifier_usages triggers maintain. */
export const readModifierAggregates = countColumnsReader("modifiers", [
  "total_uses",
  "usage_count",
]);

/** Read `booked_quantity` and `tickets_count` for a listing: the two columns
 * that the listing_attendees triggers maintain. */
export const readListingAggregates = countColumnsReader("listings", [
  "booked_quantity",
  "tickets_count",
]);

export const triggerNames = async (): Promise<Set<string>> => {
  const result = await getDb().execute(
    sql`SELECT name FROM sqlite_master WHERE type = 'trigger'`,
  );
  return new Set(result.rows.map((row) => String(row.name)));
};

/**
 * The three trigger-name suffixes — `_insert`, `_delete`, `_update` — that turn a
 * {@link LegacyAggregateTriggerSpec.triggerStem} into the full set of triggers a
 * drop-column migration drops and rebuilds (kept in a stable order so callers
 * and tests agree which three names exist).
 */
const AGGREGATE_TRIGGER_OPS = ["insert", "delete", "update"] as const;

export const legacyAggregateTriggerNames = (
  stem: string,
): readonly [string, string, string] =>
  AGGREGATE_TRIGGER_OPS.map((op) => `${stem}_${op}`) as [
    string,
    string,
    string,
  ];

/**
 * Spec for the legacy aggregate-storing column a drop-column migration removes
 * and the trio of triggers that maintained it. Both `2026-06-22_drop_listing_income`
 * (listings.income, fired by listing_attendees triggers) and
 * `2026-06-22_drop_modifiers_total_revenue` (modifiers.total_revenue, fired by
 * modifier_usages triggers) fit this shape, so the database-seed scaffolding and
 * the three regressions each migration tests are identical modulo these fields.
 */
export type LegacyAggregateTriggerSpec = {
  /** The migration's `up()`; the three regressions run this after seeding the pre-drop state. */
  readonly runMigration: () => Promise<void>;
  /** Legacy aggregate column the migration drops from {@link targetTable}. */
  readonly dropColumn: string;
  /** Article + noun used in the "rebuilt triggers still maintain the counts without … column" test name (e.g. "an income", "a revenue"). */
  readonly dropColumnPhrase: string;
  /** Table the legacy triggers update (e.g. listings, modifiers). */
  readonly targetTable: string;
  /** Trigger-name stem; combined with `_insert`/`_delete`/`_update` for the three triggers. */
  readonly triggerStem: string;
  /** Usage table the triggers fire on (e.g. listing_attendees, modifier_usages). */
  readonly usageTable: string;
  /** Columns listed in the `AFTER UPDATE OF <cols>` clause of the update trigger. */
  readonly updateOfColumns: readonly string[];
  /** Incrementing SQL the legacy triggers apply to the target row (signed `+`/`-`, `NEW`/`OLD`). */
  readonly contribution: (sign: "+" | "-", row: "NEW" | "OLD") => SqlStatement;
  /** Create the subject target row before restoring the dropped column, so the app's
   *  ledger-based read isn't run against a table that also carries the stored column. */
  readonly createSubject: () => Promise<{ id: number }>;
  /** Insert a single usage row that exercises the rebuilt triggers. */
  readonly insertUsage: (subjectId: number) => Promise<unknown>;
  /** Read the maintained aggregates from the target row after the insert. */
  readonly readAggregates: (
    subjectId: number,
  ) => Promise<Record<string, number>>;
  /** The expected aggregate readings after the usage insert in the third test. */
  readonly expected: Record<string, number>;
};

/**
 * Install the three legacy aggregate-maintaining triggers a drop-column
 * migration replaces. Each trigger body is built from the spec's
 * `contribution` so it mirrors the pre-migration database shape (triggers that
 * still reference the column the migration removes).
 *
 * The DROP TRIGGER statements are simple and batched together in one
 * round-trip; the CREATE TRIGGER statements each run as an individual
 * `execute()` because a compound `CREATE TRIGGER … BEGIN … END` carries
 * internal semicolons that some libsql batch transports mis-split (see
 * `schema-sync.ts`'s `recreateTable` for the same constraint in production).
 */
export const installLegacyAggregateTriggers = async (
  spec: Pick<
    LegacyAggregateTriggerSpec,
    "triggerStem" | "usageTable" | "updateOfColumns" | "contribution"
  >,
): Promise<void> => {
  const [insertName, deleteName, updateName] = legacyAggregateTriggerNames(
    spec.triggerStem,
  );
  const usageTable = sqlName(spec.usageTable);
  const bodies: Record<string, SqlStatement> = {
    [deleteName]: sql`AFTER DELETE ON ${usageTable}
FOR EACH ROW BEGIN
  ${spec.contribution("-", "OLD")}
END`,
    [insertName]: sql`AFTER INSERT ON ${usageTable}
FOR EACH ROW BEGIN
  ${spec.contribution("+", "NEW")}
END`,
    [updateName]: sql`AFTER UPDATE OF ${sqlNames(spec.updateOfColumns)} ON ${usageTable}
FOR EACH ROW BEGIN
  ${spec.contribution("-", "OLD")}
  ${spec.contribution("+", "NEW")}
END`,
  };
  const names = legacyAggregateTriggerNames(spec.triggerStem);
  await executeStatements(
    names.map((name) => sql`DROP TRIGGER IF EXISTS ${sqlName(name)}`),
  );
  for (const name of names) {
    await getDb().execute(
      sql`CREATE TRIGGER ${sqlName(name)} ${bodies[name]!}`,
    );
  }
};

/**
 * Build the pre-migration state a drop-column migration removes: restore the
 * legacy aggregate column on {@link LegacyAggregateTriggerSpec.targetTable} and
 * install the legacy triggers that maintained it (as a production DB had before
 * the drop).
 */
export const seedLegacyAggregateColumnDropSchema = async (
  spec: Pick<
    LegacyAggregateTriggerSpec,
    | "dropColumn"
    | "targetTable"
    | "triggerStem"
    | "usageTable"
    | "updateOfColumns"
    | "contribution"
  >,
): Promise<void> => {
  await getDb().execute(
    sql`ALTER TABLE ${sqlName(spec.targetTable)} ADD COLUMN ${sqlName(spec.dropColumn)} INTEGER NOT NULL DEFAULT 0`,
  );
  await installLegacyAggregateTriggers(spec);
};

/** The tables that the rename migration removes. */
const LEGACY_EVENT_TABLES = ["events", "event_attendees", "event_questions"];

/** The tables that the rename migration leaves, each with one seeded row. */
const LISTING_DOMAIN_TABLES = [
  "listings",
  "listing_attendees",
  "listing_questions",
];

/**
 * Assert the post-`renameEventsToListings` schema state: the three legacy
 * `event_*` tables are gone, the three `listing_*` tables exist with one row
 * each, and the activity-log and built-sites rows still link back to the seeded
 * listing. Used by the `2026-06-14_rename_events_to_listings` migration tests
 * to verify both a clean pre-rename database and a damaged intermediate state
 * self-heal to this final shape — the per-test `schemaHashMarker` check that
 * follows stays inline since the two tests bracket it differently.
 */
export const expectListingDomainRestored = async (
  listingId: number,
): Promise<void> => {
  const results = await queryLabelledBatch([
    ...[...LEGACY_EVENT_TABLES, ...LISTING_DOMAIN_TABLES].map((table) => ({
      label: `${table}_exists`,
      statement: sql`SELECT 1 AS v FROM sqlite_master WHERE type='table' AND name=${table}`,
    })),
    ...LISTING_DOMAIN_TABLES.map((table) => ({
      label: `${table}_count`,
      statement: sql`SELECT COUNT(*) AS v FROM ${sqlName(table)}`,
    })),
    {
      label: "activity_log_listing_id",
      statement: sql`SELECT listing_id AS v FROM activity_log WHERE message = 'legacy listing activity'`,
    },
    {
      label: "built_sites_listing_id",
      statement: sql`SELECT assigned_listing_id AS v FROM built_sites WHERE site_data = '{}'`,
    },
  ]);
  const exists = (label: string) => results.get(label)!.rows.length > 0;
  const scalar = (label: string) => results.get(label)!.rows[0]?.v;
  for (const table of LEGACY_EVENT_TABLES) {
    expect(exists(`${table}_exists`)).toBe(false);
  }
  for (const table of LISTING_DOMAIN_TABLES) {
    expect(exists(`${table}_exists`)).toBe(true);
    expect(Number(scalar(`${table}_count`))).toBe(1);
  }
  expect(scalar("activity_log_listing_id")).toBe(listingId);
  expect(scalar("built_sites_listing_id")).toBe(listingId);
};

/**
 * Re-run the migration chain against a database that's been reset to the
 * pre-rename shape (via {@link markMigrationsForRerun}) and assert the listing
 * domain is restored to its post-`renameEventsToListings` state. The two
 * `renameEventsToListings` regressions share this exact run-then-verify step —
 * one starts from a clean legacy DB, the other from a damaged intermediate —
 * so it lives here instead of being duplicated in each test body.
 */
export const rerunMigrationsAndExpectListingDomainRestored = async (
  listingId: number,
): Promise<void> => {
  await markMigrationsForRerun();
  await initDb();
  await expectListingDomainRestored(listingId);
};

/**
 * Register the three regressions every aggregate-column-drop migration shares:
 *
 * 1. drops the legacy aggregate column from its target table,
 * 2. keeps the three rebuild triggers in place after the drop,
 * 3. the rebuilt triggers still maintain the counts when the legacy column is gone.
 *
 * Call from inside a `describeWithEnv(...)` block; the spec carries the
 * migration runner and all caller-specific bits.
 */
export const runAggregateColumnDropTests = (
  spec: LegacyAggregateTriggerSpec,
): void => {
  test(`drops the ${spec.dropColumn} column from ${spec.targetTable}`, async () => {
    await seedLegacyAggregateColumnDropSchema(spec);
    assertArrayIncludes(await columnNames(spec.targetTable), [spec.dropColumn]);
    await spec.runMigration();
    assert(!(await columnNames(spec.targetTable)).includes(spec.dropColumn));
  });

  test("keeps the three aggregate triggers in place", async () => {
    await seedLegacyAggregateColumnDropSchema(spec);
    await spec.runMigration();
    const triggers = await triggerNames();
    for (const name of legacyAggregateTriggerNames(spec.triggerStem)) {
      expect(triggers.has(name)).toBe(true);
    }
  });

  test(`rebuilt triggers still maintain the counts without ${spec.dropColumnPhrase} column`, async () => {
    // Create the subject before restoring the dropped column, so the app's
    // ledger-based read (which projects its own aggregate) isn't run against a
    // table that also carries the stored column.
    const subject = await spec.createSubject();
    await seedLegacyAggregateColumnDropSchema(spec);
    await spec.runMigration();
    // The legacy triggers referenced spec.dropColumn; if the migration had not
    // replaced them, this insert would fail on the now-missing column.
    await spec.insertUsage(subject.id);
    expect(await spec.readAggregates(subject.id)).toEqual(spec.expected);
  });
};
