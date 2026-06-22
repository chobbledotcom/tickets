import { getDb } from "#shared/db/client.ts";
import { invalidateInitDbCache } from "#shared/db/migrations.ts";
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
