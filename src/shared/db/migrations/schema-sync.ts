import type { InValue } from "@libsql/client";
import {
  executeBatch,
  getDb,
  queryBatchPrimary,
  withTransaction,
} from "#shared/db/client.ts";
import { logDebug } from "#shared/logger.ts";
import {
  APP_SCHEMA,
  type Column,
  type Index,
  SCHEMA,
  type Table,
  TICKET_COUNTS_PREDICATE,
  TRIGGERS,
  ticketCountPredicateFor,
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

type RebuildParams = {
  columns: readonly Column[];
  copyColumns?: readonly Column[];
  sourceExists?: boolean;
  tableName: string;
  tmpName?: string;
};

/**
 * The ordered statements that rebuild a table from a column list, preserving
 * data for the listed columns: stage a fresh table, copy the rows across, drop
 * the original, then rename the staged table into its place. Shared by the
 * batch rebuild ({@link rebuildTableWithColumns}) and the atomic
 * {@link recreateTable}.
 */
const rebuildStatements = ({
  columns,
  copyColumns = columns,
  sourceExists = true,
  tableName,
  tmpName = `${tableName}_new`,
}: RebuildParams): string[] => {
  const colNames = copyColumns.map(([col]) => col).join(", ");
  const colDefs = columns.map(([col, type]) => `${col} ${type}`).join(", ");
  const selectExprs = copyColumns.map(copyExpressionFor).join(", ");
  return [
    `DROP TABLE IF EXISTS ${tmpName}`,
    `CREATE TABLE ${tmpName} (${colDefs})`,
    ...(sourceExists && copyColumns.length > 0
      ? [
          `INSERT INTO ${tmpName} (${colNames}) SELECT ${selectExprs} FROM ${tableName}`,
        ]
      : []),
    `DROP TABLE ${sourceExists ? "" : "IF EXISTS "}${tableName}`,
    `ALTER TABLE ${tmpName} RENAME TO ${tableName}`,
  ];
};

export const rebuildTableWithColumns = async (
  params: RebuildParams,
): Promise<void> => {
  await executeBatch(
    rebuildStatements(params).map((sql) => ({ args: [], sql })),
  );
};

const LISTING_AGGREGATE_TRIGGER_DEPENDENCIES = [
  "attendees",
  "listings",
  "listing_attendees",
] as const;

const LISTING_AGGREGATE_TRIGGER_COLUMN_DEPENDENCIES = [
  ["attendees", ["kind"]],
  ["listings", ["booked_quantity", "tickets_count"]],
  ["listing_attendees", ["attendee_id", "listing_id", "quantity"]],
] as const;

const isListingAggregateTrigger = (triggerName: string): boolean =>
  triggerName.startsWith("trg_listing_attendees_aggregates_");

const triggerDependencies = (triggerName: string, table: string): string[] =>
  isListingAggregateTrigger(triggerName)
    ? [...LISTING_AGGREGATE_TRIGGER_DEPENDENCIES]
    : [table];

const triggerColumnDependencies = (
  triggerName: string,
  table: string,
): readonly (readonly [string, readonly string[]])[] =>
  isListingAggregateTrigger(triggerName)
    ? LISTING_AGGREGATE_TRIGGER_COLUMN_DEPENDENCIES
    : [[table, []]];

const requiredTriggerColumns = (
  triggerName: string,
  table: string,
  dependency: string,
): readonly string[] =>
  triggerColumnDependencies(triggerName, table).find(
    ([dependencyTable]) => dependencyTable === dependency,
  )![1];

const triggersDependingOn = (tableName: string) =>
  TRIGGERS.filter((trigger) =>
    triggerDependencies(trigger.name, trigger.table).includes(tableName),
  );

const liveColumnsForTriggerDependency = (
  dependency: string,
  liveTables: Map<string, Set<string>>,
  rebuildingTable?: string,
): Set<string> | undefined =>
  dependency === rebuildingTable
    ? new Set(currentSchemaTable(dependency).columns.map(([column]) => column))
    : liveTables.get(dependency);

const canCreateTrigger = (
  triggerName: string,
  table: string,
  liveTables: Map<string, Set<string>>,
  rebuildingTable?: string,
): boolean =>
  triggerDependencies(triggerName, table).every((dependency) => {
    const columns = liveColumnsForTriggerDependency(
      dependency,
      liveTables,
      rebuildingTable,
    );
    return (
      columns !== undefined &&
      requiredTriggerColumns(triggerName, table, dependency).every((column) =>
        columns.has(column),
      )
    );
  });

/**
 * Recreate a table from its SCHEMA definition, preserving data for matching
 * columns.
 *
 * The rebuild (copy into a fresh table), its indexes, and its triggers all run
 * inside ONE interactive transaction, so the table is never committed without
 * the indexes and triggers that enforce its invariants. Any failure rolls the
 * whole rebuild back and leaves the original table untouched, instead of
 * leaving a live table missing (say) a UNIQUE index until the migration is
 * retried — a window in which duplicate rows could land and then permanently
 * break the index re-creation. An interactive transaction (rather than a batch)
 * is what makes this possible: a compound `CREATE TRIGGER … BEGIN … END`
 * carries internal semicolons that some batch transports mis-split, so triggers
 * cannot ride in a batch — but each is sent through its own `tx.execute()` here
 * and still commits atomically with the rebuild.
 *
 * The new table is created WITHOUT foreign keys (only column definitions), so
 * any FKs the original table had are removed after recreation.
 *
 * IMPORTANT: If other tables have FKs referencing this table and contain data,
 * those tables must be recreated FIRST (to remove their FK constraints).
 * Otherwise DROP TABLE will fail with FOREIGN KEY constraint in libsql.
 * We do NOT use PRAGMA foreign_keys=OFF because it doesn't persist across
 * HTTP requests in remote libsql (Turso).
 */
export const recreateTable = async (tableName: string): Promise<void> => {
  const tableSchema = currentSchemaTable(tableName);
  const live = await snapshotLiveSchema();
  const copyColumns = currentSchemaColumnsPresentIn(
    tableName,
    live.tables.get(tableName) ?? new Set(),
  );
  const dependentTriggers = triggersDependingOn(tableName);
  const liveDependentTriggerNames = new Set(
    dependentTriggers
      .filter((trigger) => live.triggers.has(trigger.name))
      .map((trigger) => trigger.name),
  );
  const statements = [
    ...dependentTriggers.map(
      (trigger) => `DROP TRIGGER IF EXISTS ${trigger.name}`,
    ),
    ...rebuildStatements({
      columns: tableSchema.columns,
      copyColumns,
      sourceExists: live.tables.has(tableName),
      tableName,
    }),
    ...(tableSchema.indexes ?? []).map((idx) => createIndexSql(tableName, idx)),
    // Triggers on this table were dropped with the old table; triggers on other
    // tables may also have been dropped because they read this table. Restore
    // both in the same transaction when their dependencies are present.
    ...TRIGGERS.filter(
      (trg) =>
        (trg.table === tableName || liveDependentTriggerNames.has(trg.name)) &&
        canCreateTrigger(trg.name, trg.table, live.tables, tableName),
    ).map((trg) => trg.sql),
  ];
  await withTransaction(async (tx) => {
    for (const sql of statements) await tx.execute(sql);
  });
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
      "attachment_downloads",
    ],
  );

  // refunded and price_paid were both dropped from listing_attendees (refund
  // status and per-row amount paid are now projected from the transfers ledger),
  // so the legacy attendees.refunded_v2 / price_paid_v2 values are not restored —
  // a historical paid or refunded booking re-surfaces via its backfilled sale /
  // refund_cash leg, not a per-row column.
  await getDb().execute(
    `INSERT OR IGNORE INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, checked_in, attachment_downloads)
     SELECT listing_id, id,
       CASE WHEN date IS NOT NULL THEN date || 'T00:00:00Z' ELSE NULL END,
       CASE WHEN date IS NOT NULL THEN DATE(date, '+1 day') || 'T00:00:00Z' ELSE NULL END,
       quantity, checked_in_v2, attachment_downloads
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
    if (
      !live.triggers.has(trg.name) &&
      canCreateTrigger(trg.name, trg.table, live.tables)
    ) {
      await runMigration(trg.sql);
    }
  }
  for (const name of live.triggers) {
    if (name.startsWith("trg_") && !declaredNames.has(name)) {
      await runMigration(`DROP TRIGGER IF EXISTS ${name}`);
    }
  }
};

/**
 * Recompute the listings aggregate columns from listing_attendees in a single
 * statement. tickets_count counts only quantity > 0 rows (the no-quantity
 * sentinel is not a ticket — see {@link TICKET_COUNTS_PREDICATE}); the
 * booked_quantity sum stays over all rows. Income is no longer an aggregate
 * column (projected from the transfers ledger at read time). Exported for the
 * shared-predicate guard test. One-time on migration; afterwards the triggers
 * keep them current. Idempotent (absolute recompute, not a delta), so re-runs.
 */
export const BACKFILL_LISTING_AGGREGATES_SQL = `UPDATE listings SET
       booked_quantity = COALESCE(
         (SELECT SUM(quantity) FROM listing_attendees WHERE listing_id = listings.id), 0),
       tickets_count = COALESCE(
         (SELECT COUNT(*) FROM listing_attendees WHERE listing_id = listings.id AND ${ticketCountPredicateFor(
           "quantity",
           "attendee_id",
         )}), 0)`;

const BACKFILL_LEGACY_LISTING_AGGREGATES_SQL = `UPDATE listings SET
       booked_quantity = COALESCE(
         (SELECT SUM(quantity) FROM listing_attendees WHERE listing_id = listings.id), 0),
       tickets_count = COALESCE(
         (SELECT COUNT(*) FROM listing_attendees WHERE listing_id = listings.id AND quantity > 0), 0)`;

const BACKFILL_LISTING_AGGREGATES_SQL_BY_SCHEMA = {
  current: BACKFILL_LISTING_AGGREGATES_SQL,
  legacy: BACKFILL_LEGACY_LISTING_AGGREGATES_SQL,
};

export const backfillListingAggregates = async (): Promise<void> => {
  const attendeeColumns = await getExistingColumns("attendees");
  const sql = attendeeColumns.has("kind")
    ? BACKFILL_LISTING_AGGREGATES_SQL_BY_SCHEMA.current
    : BACKFILL_LISTING_AGGREGATES_SQL_BY_SCHEMA.legacy;
  await getDb().execute({ args: [], sql });
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
         (SELECT COUNT(*) FROM modifier_usages WHERE modifier_id = modifiers.id), 0)`,
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
