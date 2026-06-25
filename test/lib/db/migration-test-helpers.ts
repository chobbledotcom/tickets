import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { initDb, invalidateInitDbCache } from "#shared/db/migrations.ts";
import { createTestListing } from "#test-utils";

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

const renameStepSql = (step: SchemaRenameStep): string =>
  step.kind === "table"
    ? `ALTER TABLE ${step.from} RENAME TO ${step.to}`
    : `ALTER TABLE ${step.table} RENAME COLUMN ${step.from} TO ${step.to}`;

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
  return getDb().execute("DROP TABLE IF EXISTS schema_migrations");
};

export const markMigrationsForRerun = async (): Promise<void> => {
  await getDb().execute("DROP TABLE IF EXISTS schema_migrations");
  await getDb().execute(
    "UPDATE settings SET value = 'stale' WHERE key IN ('latest_db_update', 'db_schema_hash')",
  );
  invalidateInitDbCache();
};

export const schemaHashMarker = async (): Promise<unknown> => {
  const result = await getDb().execute(
    "SELECT value FROM settings WHERE key = 'db_schema_hash'",
  );
  return result.rows[0]?.value;
};

export const seedListingDomainRows = async (): Promise<number> => {
  const listing = await createTestListing();
  await getDb().execute(
    "INSERT INTO listing_attendees (listing_id, attendee_id) VALUES (?, 999)",
    [listing.id],
  );
  await getDb().execute(
    "INSERT INTO listing_questions (listing_id, question_id) VALUES (?, 999)",
    [listing.id],
  );
  await getDb().execute(
    "INSERT INTO activity_log (created, listing_id, message) VALUES ('2024-01-01T00:00:00Z', ?, 'legacy listing activity')",
    [listing.id],
  );
  await getDb().execute(
    "INSERT INTO built_sites (site_data, assigned_listing_id, created) VALUES ('{}', ?, '2024-01-01T00:00:00Z')",
    [listing.id],
  );
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
export const seedPreDropLedgerColumns = async (): Promise<void> => {
  await getDb().execute(
    "ALTER TABLE listing_attendees ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0",
  );
  await getDb().execute(
    "ALTER TABLE listing_attendees ADD COLUMN price_paid INTEGER NOT NULL DEFAULT 0",
  );
};

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
  getDb().execute({
    args: [amount, attendeeId, listingId],
    sql: "UPDATE listing_attendees SET price_paid = ? WHERE attendee_id = ? AND listing_id = ?",
  });

export const columnNames = async (table: string): Promise<string[]> => {
  const result = await getDb().execute(
    `SELECT name FROM pragma_table_info('${table}')`,
  );
  return result.rows.map((row) => String(row.name));
};

export const tableExists = async (table: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [table],
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  });
  return result.rows.length > 0;
};

export const tableNames = async (): Promise<Set<string>> => {
  const result = await getDb().execute(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  return new Set(result.rows.map((row) => String(row.name)));
};

export const tableRowCount = async (table: string): Promise<number> => {
  const result = await getDb().execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(result.rows[0]!.n);
};

/** Read `total_uses` and `usage_count` for a modifier — the two columns the
 *  modifier_usages triggers maintain. Shared by the modifier-aggregates test
 *  suite and the drop_modifiers_total_revenue migration test. */
export const readModifierAggregates = async (
  modifierId: number,
): Promise<Record<string, number>> => {
  const result = await getDb().execute({
    args: [modifierId],
    sql: "SELECT total_uses, usage_count FROM modifiers WHERE id = ?",
  });
  const row = result.rows[0]!;
  return {
    total_uses: Number(row.total_uses),
    usage_count: Number(row.usage_count),
  };
};

/** Read `booked_quantity` and `tickets_count` for a listing — the two columns
 *  the listing_attendees triggers maintain. Shared by the listing-aggregates
 *  test suite and the drop_listing_income migration test. */
export const readListingAggregates = async (
  listingId: number,
): Promise<Record<string, number>> => {
  const result = await getDb().execute({
    args: [listingId],
    sql: "SELECT booked_quantity, tickets_count FROM listings WHERE id = ?",
  });
  const row = result.rows[0]!;
  return {
    booked_quantity: Number(row.booked_quantity),
    tickets_count: Number(row.tickets_count),
  };
};

export const triggerNames = async (): Promise<Set<string>> => {
  const result = await getDb().execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
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
  readonly contribution: (sign: "+" | "-", row: "NEW" | "OLD") => string;
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
  const bodies: Record<string, string> = {
    [deleteName]: `AFTER DELETE ON ${spec.usageTable}
FOR EACH ROW BEGIN
  ${spec.contribution("-", "OLD")}
END`,
    [insertName]: `AFTER INSERT ON ${spec.usageTable}
FOR EACH ROW BEGIN
  ${spec.contribution("+", "NEW")}
END`,
    [updateName]: `AFTER UPDATE OF ${spec.updateOfColumns.join(", ")} ON ${spec.usageTable}
FOR EACH ROW BEGIN
  ${spec.contribution("-", "OLD")}
  ${spec.contribution("+", "NEW")}
END`,
  };
  for (const name of legacyAggregateTriggerNames(spec.triggerStem)) {
    await getDb().execute(`DROP TRIGGER IF EXISTS ${name}`);
    await getDb().execute(`CREATE TRIGGER ${name} ${bodies[name]}`);
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
    `ALTER TABLE ${spec.targetTable} ADD COLUMN ${spec.dropColumn} INTEGER NOT NULL DEFAULT 0`,
  );
  await installLegacyAggregateTriggers(spec);
};

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
  expect(await tableExists("events")).toBe(false);
  expect(await tableExists("event_attendees")).toBe(false);
  expect(await tableExists("event_questions")).toBe(false);
  expect(await tableExists("listings")).toBe(true);
  expect(await tableExists("listing_attendees")).toBe(true);
  expect(await tableExists("listing_questions")).toBe(true);
  expect(await tableRowCount("listings")).toBe(1);
  expect(await tableRowCount("listing_attendees")).toBe(1);
  expect(await tableRowCount("listing_questions")).toBe(1);

  const activity = await getDb().execute(
    "SELECT listing_id FROM activity_log WHERE message = 'legacy listing activity'",
  );
  expect(activity.rows[0]?.listing_id).toBe(listingId);
  const builtSite = await getDb().execute(
    "SELECT assigned_listing_id FROM built_sites WHERE site_data = '{}'",
  );
  expect(builtSite.rows[0]?.assigned_listing_id).toBe(listingId);
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
    expect(await columnNames(spec.targetTable)).toContain(spec.dropColumn);
    await spec.runMigration();
    expect(await columnNames(spec.targetTable)).not.toContain(spec.dropColumn);
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
