import type { InValue } from "@libsql/client";
import { executeBatch, getDb, queryBatchPrimary } from "#shared/db/client.ts";
import { logDebug } from "#shared/logger.ts";
import {
  APP_SCHEMA,
  type Column,
  type Index,
  SCHEMA,
  type Table,
  TRIGGERS,
} from "./schema.ts";
import {
  assertColumnsPresent,
  assertLiveTableColumns,
} from "./schema-assertions.ts";

/** Run an idempotent migration — swallows expected "already done" errors */
export const runMigration = async (sql: string): Promise<void> => {
  try {
    await getDb().execute(sql);
  } catch (e) {
    const msg = String(e);
    // Expected when re-running on an already-migrated DB or racing another
    // isolate through an idempotent DDL statement.
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      return;
    }
    // Anything else is a real error — log and rethrow
    logDebug("Migration", `Error: ${msg} — SQL: ${sql.slice(0, 80)}`);
    throw e;
  }
};

/** Get the set of existing column names for a table */
export const getExistingColumns = async (
  table: string,
): Promise<Set<string>> => {
  const result = await getDb().execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
};

export const tableExists = async (table: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [table],
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  });
  return result.rows.length > 0;
};

/** Live schema snapshot: every table's columns, every index, every trigger. */
export type LiveSchema = {
  /** table name → set of its column names */
  tables: Map<string, Set<string>>;
  /** all index names present (including sqlite_autoindex_*) */
  indexes: Set<string>;
  /** all trigger names present */
  triggers: Set<string>;
};

/**
 * Snapshot the entire live schema in a single batched round-trip.
 *
 * Edge requests cap outbound subrequests (each libsql `execute`/`batch` is one
 * `fetch`), so the per-table `PRAGMA table_info`/`sqlite_master` probes that
 * schema sync and verification used to fire in loops — dozens of subrequests —
 * are collapsed into two SELECTs sent as one read batch. The first joins
 * `sqlite_master` against the `pragma_table_info` table-valued function to read
 * every column of every table at once; the second lists every index name.
 *
 * Pinned to the primary (not a replica): every caller runs inside a migration,
 * where the snapshot must reflect DDL applied moments earlier in the same run.
 * A replica that lags behind that write would report a just-created table as
 * missing, failing verify() spuriously (see queryBatchPrimary).
 */
export const snapshotLiveSchema = async (): Promise<LiveSchema> => {
  const [columns, indexRows, triggerRows] = await queryBatchPrimary([
    {
      args: [],
      sql:
        "SELECT m.name AS tbl, ti.name AS col " +
        "FROM sqlite_master m JOIN pragma_table_info(m.name) ti " +
        "WHERE m.type = 'table'",
    },
    {
      args: [],
      sql: "SELECT name FROM sqlite_master WHERE type = 'index'",
    },
    {
      args: [],
      sql: "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    },
  ]);

  const tables = new Map<string, Set<string>>();
  for (const row of columns!.rows) {
    const tbl = String(row.tbl);
    const cols = tables.get(tbl) ?? new Set<string>();
    cols.add(String(row.col));
    tables.set(tbl, cols);
  }

  const indexes = new Set(indexRows!.rows.map((row) => String(row.name)));
  const triggers = new Set(triggerRows!.rows.map((row) => String(row.name)));
  return { indexes, tables, triggers };
};

/** Build the idempotent CREATE INDEX statement for a declared index. */
const createIndexSql = (tableName: string, idx: Index): string => {
  const unique = idx.unique ? "UNIQUE " : "";
  return `CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON ${tableName}(${idx.columns.join(
    ", ",
  )})`;
};

/** Create indexes for a named table from SCHEMA */
const createIndexesForTable = async (
  tableName: string,
  indexes: Index[],
): Promise<void> => {
  for (const idx of indexes) {
    await runMigration(createIndexSql(tableName, idx));
  }
};

/**
 * (Re)create every declared trigger that fires on a named table. Called after
 * {@link recreateTable} rebuilds a table, since dropping the old table also
 * drops its triggers. Statements are `CREATE TRIGGER IF NOT EXISTS`, so this is
 * idempotent.
 */
const createTriggersForTable = async (tableName: string): Promise<void> => {
  for (const trg of TRIGGERS) {
    if (trg.table === tableName) await runMigration(trg.sql);
  }
};

const currentSchemaTable = (tableName: string): Table => {
  const table = SCHEMA.find(([name]) => name === tableName)?.[1];
  if (!table) throw new Error(`Unknown schema table ${tableName}`);
  return table;
};

export const currentSchemaColumnsPresentIn = (
  tableName: string,
  existingColumns: Set<string>,
): Column[] =>
  currentSchemaTable(tableName).columns.filter(([column]) =>
    existingColumns.has(column),
  );

const copyExpressionFor = ([column, type]: Column): string => {
  const defaultMatch = type.match(/DEFAULT\s+'([^']*)'/i);
  return defaultMatch ? `COALESCE(${column}, '${defaultMatch[1]}')` : column;
};

export const rebuildTableWithColumns = async ({
  columns,
  tableName,
  tmpName = `${tableName}_new`,
}: {
  columns: readonly Column[];
  tableName: string;
  tmpName?: string;
}): Promise<void> => {
  const colNames = columns.map(([col]) => col).join(", ");
  const colDefs = columns.map(([col, type]) => `${col} ${type}`).join(", ");
  const selectExprs = columns.map(copyExpressionFor).join(", ");

  await executeBatch([
    { args: [], sql: `DROP TABLE IF EXISTS ${tmpName}` },
    { args: [], sql: `CREATE TABLE ${tmpName} (${colDefs})` },
    {
      args: [],
      sql:
        `INSERT INTO ${tmpName} (${colNames}) ` +
        `SELECT ${selectExprs} FROM ${tableName}`,
    },
    { args: [], sql: `DROP TABLE ${tableName}` },
    { args: [], sql: `ALTER TABLE ${tmpName} RENAME TO ${tableName}` },
  ]);
};

/**
 * Recreate a table from its SCHEMA definition, preserving data for matching columns.
 *
 * The new table is created WITHOUT foreign keys (only column definitions).
 * This means any FKs the original table had are removed after recreation.
 *
 * IMPORTANT: If other tables have FKs referencing this table and contain data,
 * those tables must be recreated FIRST (to remove their FK constraints).
 * Otherwise DROP TABLE will fail with FOREIGN KEY constraint in libsql.
 * We do NOT use PRAGMA foreign_keys=OFF because it doesn't persist across
 * HTTP requests in remote libsql (Turso).
 */
export const recreateTable = async (tableName: string): Promise<void> => {
  const tableSchema = currentSchemaTable(tableName);
  await rebuildTableWithColumns({
    columns: tableSchema.columns,
    tableName,
  });

  await createIndexesForTable(tableName, tableSchema.indexes ?? []);
  // Triggers on this table were dropped with the old table — re-create them.
  await createTriggersForTable(tableName);
};

export const getAppSchemaColumns = (tableName: string): Set<string> =>
  new Set(
    APP_SCHEMA.find(([n]) => n === tableName)![1].columns.map(([c]) => c),
  );

const requireColumns = (
  table: string,
  existing: Set<string>,
  required: string[],
): void => {
  assertColumnsPresent("legacy", table, existing, required);
};

const backfillListingAttendees = async (): Promise<void> => {
  const attendeeColumns = await getExistingColumns("attendees");
  if (!attendeeColumns.has("listing_id")) {
    logDebug(
      "Migration",
      "attendees.listing_id is absent, skipping listing_attendees backfill",
    );
    return;
  }

  requireColumns("attendees", attendeeColumns, [
    "id",
    "listing_id",
    "date",
    "quantity",
    "checked_in_v2",
    "refunded_v2",
    "price_paid_v2",
    "attachment_downloads",
  ]);
  requireColumns(
    "listing_attendees",
    await getExistingColumns("listing_attendees"),
    [
      "listing_id",
      "attendee_id",
      "start_at",
      "end_at",
      "quantity",
      "checked_in",
      "refunded",
      "price_paid",
      "attachment_downloads",
    ],
  );

  await getDb().execute(
    `INSERT OR IGNORE INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads)
     SELECT listing_id, id,
       CASE WHEN date IS NOT NULL THEN date || 'T00:00:00Z' ELSE NULL END,
       CASE WHEN date IS NOT NULL THEN DATE(date, '+1 day') || 'T00:00:00Z' ELSE NULL END,
       quantity, checked_in_v2, refunded_v2, price_paid_v2, attachment_downloads
     FROM attendees
     WHERE id NOT IN (SELECT attendee_id FROM listing_attendees)`,
  );
};

/**
 * Drop any legacy columns from attendees that aren't in the current schema
 * (listing_id, date, quantity, and the pre-pii_blob PII columns: name, email,
 * phone, address, payment_id, etc).
 *
 * SQLite can't DROP COLUMN when a FK references the column, so we recreate
 * the table. Idempotent: if every existing column matches the schema, skip.
 */
const dropDeprecatedAttendeeColumns = async (): Promise<void> => {
  const cols = await getExistingColumns("attendees");
  const expected = getAppSchemaColumns("attendees");
  const hasLegacy = [...cols].some((c) => !expected.has(c));
  if (!hasLegacy) {
    logDebug(
      "Migration",
      "attendees has no legacy columns, skipping table recreation",
    );
    return;
  }
  // Recreate tables that reference attendees(id) FIRST — the live DB's
  // original tables have FK declarations baked in from their CREATE TABLE.
  // libsql won't let us DROP attendees while those FKs exist. Recreating
  // them first replaces the FK-bearing originals with clean versions.
  logDebug("Migration", "Recreating listing_attendees (removing FKs)...");
  await recreateTable("listing_attendees");
  logDebug("Migration", "Recreating processed_payments (removing FKs)...");
  await recreateTable("processed_payments");
  logDebug("Migration", "Recreating attendee_answers (removing FKs)...");
  await recreateTable("attendee_answers");
  // Now safe to recreate attendees — no other table references it via FK
  logDebug(
    "Migration",
    "Recreating attendees (dropping deprecated columns)...",
  );
  await recreateTable("attendees");
  logDebug("Migration", "Table recreation complete.");
};

/** Create missing tables and add missing columns in a single pass */
export const createTableSql = ([name, table]: [string, Table]): string => {
  const parts = table.columns.map(([col, type]) => `${col} ${type}`);
  return `CREATE TABLE IF NOT EXISTS ${name} (${parts.join(", ")})`;
};

const writeStatement = (sql: string): { args: InValue[]; sql: string } => ({
  args: [],
  sql,
});

export const applySchemaChanges = async (): Promise<void> => {
  const live = await snapshotLiveSchema();
  const statements: { args: InValue[]; sql: string }[] = [];
  for (const entry of SCHEMA) {
    const [name, table] = entry;
    const existing = live.tables.get(name);
    if (!existing) {
      // Missing table: one CREATE carries every column, so no ALTERs follow.
      statements.push({ args: [], sql: createTableSql(entry) });
      continue;
    }
    for (const [col, type] of table.columns) {
      if (!existing.has(col)) {
        statements.push({
          args: [],
          sql: `ALTER TABLE ${name} ADD COLUMN ${col} ${type}`,
        });
      }
    }
  }
  // Run statements through runMigration rather than a single batch so another
  // edge isolate can safely win the same additive schema race after our
  // snapshot. runMigration ignores idempotent duplicate/already-exists DDL
  // errors but still surfaces real failures.
  for (const statement of statements) {
    await runMigration(statement.sql);
  }
};

/** Create missing indexes and drop legacy ones */
export const syncIndexes = async (): Promise<void> => {
  const live = await snapshotLiveSchema();
  const declared = SCHEMA.flatMap(([tableName, table]) =>
    (table.indexes ?? []).map((idx) => ({
      columns: idx.columns,
      name: idx.name,
      sql: createIndexSql(tableName, idx),
      tableName,
    })),
  );
  const declaredNames = new Set(declared.map((d) => d.name));

  const creates = declared
    .filter((d) => {
      const columns = live.tables.get(d.tableName);
      return (
        columns !== undefined &&
        d.columns.every((column) => columns.has(column)) &&
        !live.indexes.has(d.name)
      );
    })
    .map((d) => writeStatement(d.sql));

  // Drop any project-owned (idx_*) index no longer declared in SCHEMA. The
  // sqlite_autoindex_* entries backing UNIQUE/PRIMARY KEY constraints never
  // match this prefix, so they're left untouched.
  const drops = [...live.indexes]
    .filter((name) => name.startsWith("idx_") && !declaredNames.has(name))
    .map((name) => writeStatement(`DROP INDEX IF EXISTS ${name}`));

  // One batched write (one subrequest) instead of a CREATE/DROP per index.
  const statements = [...creates, ...drops];
  if (statements.length > 0) await executeBatch(statements);
};

/**
 * Create missing declared triggers and drop legacy project-owned (trg_*) ones.
 * Run sequentially (not batched) because a compound CREATE TRIGGER … BEGIN …
 * END carries internal semicolons that some batch transports mis-split.
 */
export const syncTriggers = async (): Promise<void> => {
  const live = await snapshotLiveSchema();
  const declaredNames = new Set(TRIGGERS.map((t) => t.name));
  for (const trg of TRIGGERS) {
    if (!live.triggers.has(trg.name)) await runMigration(trg.sql);
  }
  for (const name of live.triggers) {
    if (name.startsWith("trg_") && !declaredNames.has(name)) {
      await runMigration(`DROP TRIGGER IF EXISTS ${name}`);
    }
  }
};

/**
 * Recompute the listings aggregate columns from listing_attendees in a single
 * statement. One-time on migration; afterwards the triggers keep them current.
 * Idempotent (absolute recompute, not a delta), so it's safe to re-run.
 */
export const backfillListingAggregates = async (): Promise<void> => {
  await getDb().execute(
    `UPDATE listings SET
       booked_quantity = COALESCE(
         (SELECT SUM(quantity) FROM listing_attendees WHERE listing_id = listings.id), 0),
       tickets_count = COALESCE(
         (SELECT COUNT(*) FROM listing_attendees WHERE listing_id = listings.id), 0),
       income = COALESCE(
         (SELECT SUM(price_paid) FROM listing_attendees WHERE listing_id = listings.id), 0)`,
  );
};

/**
 * Recompute the modifiers aggregate columns from modifier_usages in a single
 * statement. One-time on migration; afterwards the triggers keep them current.
 * Idempotent (absolute recompute, not a delta), so it's safe to re-run.
 */
export const backfillModifierAggregates = async (): Promise<void> => {
  await getDb().execute(
    `UPDATE modifiers SET
       total_uses = COALESCE(
         (SELECT SUM(quantity) FROM modifier_usages WHERE modifier_id = modifiers.id), 0),
       usage_count = COALESCE(
         (SELECT COUNT(*) FROM modifier_usages WHERE modifier_id = modifiers.id), 0),
       total_revenue = COALESCE(
         (SELECT SUM(amount_applied) FROM modifier_usages WHERE modifier_id = modifiers.id), 0)`,
  );
};

/**
 * Recompute the answers.times_selected aggregate from attendee_answers in a
 * single statement. One-time on migration; afterwards the triggers keep it
 * current. Idempotent (absolute recompute, not a delta), so it's safe to re-run.
 */
export const backfillAnswerAggregates = async (): Promise<void> => {
  await getDb().execute(
    `UPDATE answers SET
       times_selected = COALESCE(
         (SELECT COUNT(*) FROM attendee_answers WHERE answer_id = answers.id), 0)`,
  );
};

export const verifyCurrentAppSchema = async (): Promise<void> => {
  // One snapshot (a single batched round-trip) replaces the per-table
  // tableExists/getExistingColumns/indexExists probes — dozens of subrequests
  // that could alone exceed the edge per-request cap.
  const live = await snapshotLiveSchema();
  for (const [name, table] of APP_SCHEMA) {
    assertLiveTableColumns(
      "appSchema",
      live,
      name,
      table.columns.map(([col]) => col),
    );

    for (const index of table.indexes ?? []) {
      if (!live.indexes.has(index.name)) {
        throw new Error(
          `Database schema verification failed: missing index ${index.name}`,
        );
      }
    }
  }

  for (const trigger of TRIGGERS) {
    if (!live.triggers.has(trigger.name)) {
      throw new Error(
        `Database schema verification failed: missing trigger ${trigger.name}`,
      );
    }
  }
};

export const syncCurrentSchema = async (
  repairLegacySchemaRenames?: () => Promise<void>,
): Promise<void> => {
  if (repairLegacySchemaRenames) {
    logDebug(
      "Migration",
      "Step 0: repairing legacy schema renames before schema apply...",
    );
    // Must run BEFORE applySchemaChanges(): otherwise the declarative apply can
    // create empty target tables/columns first, leaving legacy data behind under
    // the old names.
    await repairLegacySchemaRenames();
  }

  logDebug("Migration", "Step 1: applying schema changes...");
  await applySchemaChanges();
  logDebug("Migration", "Step 2: syncing indexes...");
  await syncIndexes();

  logDebug("Migration", "Step 3: backfilling listing_attendees...");
  await backfillListingAttendees();

  logDebug("Migration", "Step 4: dropping deprecated attendee columns...");
  await dropDeprecatedAttendeeColumns();

  logDebug("Migration", "Step 5: syncing triggers...");
  await syncTriggers();

  logDebug("Migration", "Step 6: backfilling listing aggregates...");
  await backfillListingAggregates();

  logDebug("Migration", "Step 7: backfilling modifier aggregates...");
  await backfillModifierAggregates();

  logDebug("Migration", "Step 8: backfilling answer aggregates...");
  await backfillAnswerAggregates();
};
