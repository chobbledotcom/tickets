import {
  executeBatch,
  getDb,
  queryBatchPrimary,
  withTransaction,
} from "#db/client.ts";
import { stringColumnSet } from "#db/query.ts";
import { sql, sqlCommas, sqlLiteral, sqlName, sqlNames, type SqlStatement } from "#db/sql.ts";
import { logDebug } from "#shared/logger.ts";
import {
  backfillAnswerAggregates,
  backfillModifierAggregates,
} from "./aggregate-backfills.ts";
import { APP_SCHEMA, SCHEMA } from "./schema/index.ts";
import {
  TICKET_COUNTS_PREDICATE,
  ticketCountPredicateFor,
} from "./schema/listing-aggregates.ts";
import { TRIGGERS } from "./schema/triggers.ts";
import type { Column, Index, Table, Trigger } from "./schema/types.ts";
import {
  assertColumnsPresent,
  assertLiveTableColumns,
} from "./schema-assertions.ts";
import type { SchemaApplyScope } from "./types.ts";

/** Run an idempotent migration — swallows expected "already done" errors */
export const runMigration = async (statement: SqlStatement): Promise<void> => {
  try {
    await getDb().execute(statement);
  } catch (e) {
    const msg = String(e);
    // Expected when re-running on an already-migrated DB or racing another
    // isolate through an idempotent DDL statement.
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      return;
    }
    // Anything else is a real error — log and rethrow
    logDebug("Migration", `Error: ${msg} — SQL: ${statement.sql.slice(0, 80)}`);
    throw e;
  }
};

/** Get the set of existing column names for a table */
export const getExistingColumns = async (
  table: string,
): Promise<Set<string>> => {
  const result = await getDb().execute(
    sql`PRAGMA table_info(${sqlName(table)})`,
  );
  return stringColumnSet(result.rows, "name");
};

export const tableExists = async (table: string): Promise<boolean> => {
  const result = await getDb().execute(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  );
  return result.rows.length > 0;
};

/** Each table's live column names, keyed by table name. */
type LiveTables = Map<string, Set<string>>;

/** Live schema snapshot: every table's columns, every index, every trigger. */
export type LiveSchema = {
  /** table name → set of its column names */
  tables: LiveTables;
  /** all index names present (including sqlite_autoindex_*) */
  indexes: Set<string>;
  /** all trigger names present */
  triggers: Set<string>;
};

/**
 * Two SELECTs in one read batch, because an edge request caps outbound
 * subrequests and a per-table probe loop spends dozens of them.
 *
 * Pinned to the primary, not a replica: every caller runs inside a migration,
 * where the snapshot must reflect DDL applied moments earlier. A lagging
 * replica reports a just-created table as missing and fails verify() spuriously.
 */
export const snapshotLiveSchema = async (): Promise<LiveSchema> => {
  const [columns, indexRows, triggerRows] = await queryBatchPrimary([
    sql`SELECT master.name AS tbl, tableInfo.name AS col FROM sqlite_master AS master JOIN pragma_table_info(master.name) AS tableInfo WHERE master.type = 'table'`,
    sql`SELECT name FROM sqlite_master WHERE type = 'index'`,
    sql`SELECT name FROM sqlite_master WHERE type = 'trigger'`,
  ]);

  const tables = new Map<string, Set<string>>();
  for (const row of columns!.rows) {
    const tbl = String(row.tbl);
    const cols = tables.get(tbl) ?? new Set<string>();
    cols.add(String(row.col));
    tables.set(tbl, cols);
  }

  const indexes = stringColumnSet(indexRows!.rows, "name");
  const triggers = stringColumnSet(triggerRows!.rows, "name");
  return { indexes, tables, triggers };
};

/** Build a sync/verify step that loads its live-schema probe once, then hands
 * it to the work. Every step below opens with the same read. */
const stepUsing =
  <Probe>(loadProbe: () => Promise<Probe>) =>
  (work: (probe: Probe) => Promise<void>) =>
  async (): Promise<void> =>
    work(await loadProbe());

/** Steps that work from one whole-schema snapshot (a single batched read). */
const fromLiveSchema = stepUsing(snapshotLiveSchema);

/** Steps that fork on the live attendees table's columns — the legacy-schema
 * probe the attendee backfills and the legacy-column drop all open with. */
const fromAttendeeColumns = stepUsing(() => getExistingColumns("attendees"));

/** Build the idempotent CREATE INDEX statement for a declared index. */
const createIndexSql = (tableName: string, idx: Index): SqlStatement =>
  sql`CREATE ${idx.unique ? sql`UNIQUE ` : sql``}INDEX IF NOT EXISTS ${sqlName(
    idx.name,
  )} ON ${sqlName(tableName)}(${sqlNames(idx.columns)})${
    idx.where === undefined ? sql`` : sql` WHERE ${idx.where}`
  }`;

/** SQL identifiers, normalised the same way SQLite matches their case. */
export const schemaSqlIdentifiers = (sql: string): Set<string> =>
  new Set(
    (sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((name) =>
      name.toLowerCase(),
    ),
  );

/** Every table column an index definition reads, including its predicate. */
const columnsUsedByIndex = (index: Index, table: Table): string[] => {
  const predicateNames = schemaSqlIdentifiers(index.where?.sql ?? "");
  return [
    ...new Set([
      ...index.columns,
      ...table.columns
        .map(([column]) => column)
        .filter((column) => predicateNames.has(column.toLowerCase())),
    ]),
  ];
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

const copyExpressionFor = ([column, type]: Column): SqlStatement => {
  const defaultMatch = type.sql.match(/DEFAULT\s+'([^']*)'/i);
  return defaultMatch
    ? sql`COALESCE(${sqlName(column)}, ${sqlLiteral(defaultMatch[1]!)})`
    : sqlName(column);
};

/** Each column's name and type, as a table definition lists them. */
const columnDefinitions = (columns: readonly Column[]): SqlStatement =>
  sqlCommas(columns.map(([column, type]) => sql`${sqlName(column)} ${type}`));

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
}: RebuildParams): SqlStatement[] => {
  const source = sqlName(tableName);
  const staged = sqlName(tmpName);
  return [
    sql`DROP TABLE IF EXISTS ${staged}`,
    sql`CREATE TABLE ${staged} (${columnDefinitions(columns)})`,
    ...(sourceExists && copyColumns.length > 0
      ? [
          sql`INSERT INTO ${staged} (${sqlNames(
            copyColumns.map(([column]) => column),
          )}) SELECT ${sqlCommas(copyColumns.map(copyExpressionFor))} FROM ${source}`,
        ]
      : []),
    sql`DROP TABLE ${sourceExists ? sql`` : sql`IF EXISTS `}${source}`,
    sql`ALTER TABLE ${staged} RENAME TO ${source}`,
  ];
};

export const rebuildTableWithColumns = async (
  params: RebuildParams,
): Promise<void> => {
  await executeBatch(rebuildStatements(params));
};

const triggersDependingOn = (tableName: string) =>
  TRIGGERS.filter((trigger) => tableName in trigger.uses);

const liveColumnsForTriggerDependency = (
  dependency: string,
  liveTables: LiveTables,
  rebuildingTable?: string,
): Set<string> | undefined =>
  dependency === rebuildingTable
    ? new Set(currentSchemaTable(dependency).columns.map(([column]) => column))
    : liveTables.get(dependency);

const canCreateTrigger = (
  trigger: Trigger,
  liveTables: LiveTables,
  rebuildingTable?: string,
): boolean =>
  Object.keys(trigger.uses).every((dependency) => {
    const columns = liveColumnsForTriggerDependency(
      dependency,
      liveTables,
      rebuildingTable,
    );
    return (
      columns !== undefined &&
      trigger.uses[dependency]!.every((column) => columns.has(column))
    );
  });

/**
 * The copy, its indexes, and its triggers all run in one interactive
 * transaction. A failure that left a live table without a UNIQUE index can
 * open a window for duplicates to land and break it permanently. They go as one
 * structured batch, so a trigger body stays a single statement whose semicolons
 * are not read as separators.
 *
 * The new table has no foreign keys. If other tables hold FKs referencing this
 * one and hold data, recreate those first, or DROP TABLE fails.
 * `PRAGMA foreign_keys=OFF` does not persist across HTTP requests in remote
 * libsql, so it is no help.
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
      (trigger) => sql`DROP TRIGGER IF EXISTS ${sqlName(trigger.name)}`,
    ),
    ...rebuildStatements({
      columns: tableSchema.columns,
      copyColumns,
      sourceExists: live.tables.has(tableName),
      tableName,
    }),
    ...(tableSchema.indexes ?? []).map((idx) => createIndexSql(tableName, idx)),
    // The drop removed the triggers on this table, and it can also remove
    // triggers on other tables that read this one. Restore both in the same
    // transaction when their dependencies are present.
    ...TRIGGERS.filter(
      (trg) =>
        (trg.table === tableName || liveDependentTriggerNames.has(trg.name)) &&
        canCreateTrigger(trg, live.tables, tableName),
    ).map((trg) => trg.sql),
  ];
  await withTransaction(async (tx) => {
    await tx.batch(statements);
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
): void => assertColumnsPresent("legacy", table, existing, required);

const backfillListingAttendees = fromAttendeeColumns(
  async (attendeeColumns) => {
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

    // refunded and price_paid were both dropped from listing_attendees (both
    // project from the transfers ledger), so the legacy refunded_v2 /
    // price_paid_v2 values are not restored. A historical paid or refunded
    // booking re-surfaces via its backfilled ledger legs, not a per-row column.
    await getDb().execute(
      sql`INSERT OR IGNORE INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, checked_in, attachment_downloads)
     SELECT listing_id, id,
       CASE WHEN date IS NOT NULL THEN date || 'T00:00:00Z' ELSE NULL END,
       CASE WHEN date IS NOT NULL THEN DATE(date, '+1 day') || 'T00:00:00Z' ELSE NULL END,
       quantity, CASE WHEN checked_in_v2 = '1' AND quantity > 0 THEN quantity ELSE 0 END,
       attachment_downloads
     FROM attendees
     WHERE id NOT IN (SELECT attendee_id FROM listing_attendees)`,
    );
  },
);

/**
 * Drop any legacy columns from attendees that are not in the current schema
 * (the columns SCHEMA no longer declares).
 * SQLite can't DROP COLUMN when a FK references the column, so we recreate
 * the table. Idempotent: if every existing column matches the schema, skip.
 */
const dropDeprecatedAttendeeColumns = fromAttendeeColumns(async (cols) => {
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
});

/** Create missing tables and add missing columns in a single pass */
export const createTableSql = ([name, table]: [string, Table]): SqlStatement =>
  sql`CREATE TABLE IF NOT EXISTS ${sqlName(name)} (${columnDefinitions(
    table.columns,
  )})`;

/**
 * Every CREATE TABLE and CREATE INDEX statement for the full current schema,
 * in SCHEMA (FK-dependency) order, each table followed by its own indexes.
 * All IF NOT EXISTS and derived purely from the SCHEMA declaration — no
 * database reads — so a caller that KNOWS the database is blank (the restore
 * path, straight after resetDatabase()) can rebuild it without trusting a
 * schema snapshot that may lag behind the drops.
 */
export const fullSchemaCreateStatements = (): SqlStatement[] =>
  SCHEMA.flatMap(([name, table]) => [
    createTableSql([name, table]),
    ...(table.indexes ?? []).map((index) => createIndexSql(name, index)),
  ]);

/** The SCHEMA subset a scoped step can touch. A name outside SCHEMA is
 * refused. */
const scopedSchema = (tables: readonly string[]): [string, Table][] => {
  const wanted = new Set(tables);
  return SCHEMA.filter(([name]) => {
    if (!wanted.has(name)) return false;
    currentSchemaTable(name);
    return true;
  });
};

export const applySchemaChanges = async (
  scope?: SchemaApplyScope,
): Promise<void> => {
  const live = await snapshotLiveSchema();
  const schema = scope ? scopedSchema(scope.tables) : SCHEMA;
  const creates: SqlStatement[] = [];
  const alters: SqlStatement[] = [];
  for (const entry of schema) {
    const [name, table] = entry;
    const existing = live.tables.get(name);
    if (!existing) {
      // Missing table: one CREATE carries every column, so no ALTERs follow.
      creates.push(createTableSql(entry));
      continue;
    }
    for (const [col, type] of table.columns) {
      if (!existing.has(col)) {
        alters.push(
          sql`ALTER TABLE ${sqlName(name)} ADD COLUMN ${sqlName(col)} ${type}`,
        );
      }
    }
  }
  // Missing-table CREATEs are idempotent and independent, so one batch keeps a
  // fresh setup within Bunny's 50-subrequest limit. ALTER ADD COLUMN can race
  // another isolate after this snapshot; keep those on runMigration so an
  // already-added column is accepted without hiding real failures.
  if (creates.length > 0) await executeBatch(creates);
  for (const statement of alters) {
    await runMigration(statement);
  }
};

/** Create missing indexes and drop legacy ones */
export const syncIndexes: () => Promise<void> = fromLiveSchema(async (live) => {
  const declared = SCHEMA.flatMap(([tableName, table]) =>
    (table.indexes ?? []).map((idx) => ({
      name: idx.name,
      requiredColumns: columnsUsedByIndex(idx, table),
      sql: createIndexSql(tableName, idx),
      tableName,
    })),
  );
  const declaredNames = new Set(declared.map((d) => d.name));

  // Only create an index whose table+columns the snapshot already shows, so
  // an index on a not-yet-created table waits for that table's migration. A
  // table missing from this snapshot through read-your-writes lag reads the
  // same way; that skip is repaired one layer up, where
  // verifyMigrationWithRetry re-runs the migration (verify() scopes itself to
  // the migration's own objects).
  const creates = declared
    .filter((d) => {
      const columns = live.tables.get(d.tableName);
      return (
        columns !== undefined &&
        d.requiredColumns.every((column) => columns.has(column)) &&
        !live.indexes.has(d.name)
      );
    })
    .map((d) => d.sql);

  // Drop any project-owned (idx_*) index no longer declared in SCHEMA. The
  // sqlite_autoindex_* entries backing UNIQUE/PRIMARY KEY constraints never
  // match this prefix, so they're left untouched.
  const drops = [...live.indexes]
    .filter((name) => name.startsWith("idx_") && !declaredNames.has(name))
    .map((name) => sql`DROP INDEX IF EXISTS ${sqlName(name)}`);

  // One batched write (one subrequest) instead of a CREATE/DROP per index.
  const statements = [...creates, ...drops];
  if (statements.length > 0) await executeBatch(statements);
});

/**
 * Create missing declared triggers and drop legacy project-owned (trg_*) ones.
 * Run sequentially (not batched) because a compound CREATE TRIGGER … BEGIN …
 * END carries internal semicolons that some batch transports mis-split.
 */
export const syncTriggers: () => Promise<void> = fromLiveSchema(
  async (live) => {
    const declaredNames = new Set(TRIGGERS.map((t) => t.name));
    for (const trg of TRIGGERS) {
      if (!live.triggers.has(trg.name) && canCreateTrigger(trg, live.tables)) {
        await runMigration(trg.sql);
      }
    }
    for (const name of live.triggers) {
      if (name.startsWith("trg_") && !declaredNames.has(name)) {
        await runMigration(sql`DROP TRIGGER IF EXISTS ${sqlName(name)}`);
      }
    }
  },
);

/**
 * Recompute the listings aggregate columns from listing_attendees in a single
 * statement. tickets_count counts only quantity > 0 rows (the no-quantity
 * sentinel is not a ticket — see {@link TICKET_COUNTS_PREDICATE}); the
 * booked_quantity sum stays over all rows. Income is no longer an aggregate
 * column (projected from the transfers ledger at read time). Exported for the
 * shared-predicate guard test. One-time on migration; afterwards the triggers
 * keep them current. Idempotent (absolute recompute, not a delta), so re-runs.
 */
export const BACKFILL_LISTING_AGGREGATES_SQL = sql`UPDATE listings SET
       booked_quantity = COALESCE(
         (SELECT SUM(quantity) FROM listing_attendees WHERE listing_id = listings.id), 0),
       tickets_count = COALESCE(
         (SELECT COUNT(*) FROM listing_attendees WHERE listing_id = listings.id AND ${ticketCountPredicateFor(
           sql`quantity`,
           sql`attendee_id`,
         )}), 0)`;

const BACKFILL_LEGACY_LISTING_AGGREGATES_SQL = sql`UPDATE listings SET
       booked_quantity = COALESCE(
         (SELECT SUM(quantity) FROM listing_attendees WHERE listing_id = listings.id), 0),
       tickets_count = COALESCE(
         (SELECT COUNT(*) FROM listing_attendees WHERE listing_id = listings.id AND quantity > 0), 0)`;

const BACKFILL_LISTING_AGGREGATES_SQL_BY_SCHEMA = {
  current: BACKFILL_LISTING_AGGREGATES_SQL,
  legacy: BACKFILL_LEGACY_LISTING_AGGREGATES_SQL,
};

export const backfillListingAggregates: () => Promise<void> =
  fromAttendeeColumns(async (attendeeColumns) => {
    await getDb().execute(
      attendeeColumns.has("kind")
        ? BACKFILL_LISTING_AGGREGATES_SQL_BY_SCHEMA.current
        : BACKFILL_LISTING_AGGREGATES_SQL_BY_SCHEMA.legacy,
    );
  });

// One batched snapshot replaces the per-table tableExists/getExistingColumns
// probes — dozens of subrequests that could alone exceed the edge cap.
export const verifyCurrentAppSchema: () => Promise<void> = fromLiveSchema(
  async (live) => {
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
  },
);

export const syncCurrentSchema = async (
  repairLegacySchemaRenames?: () => Promise<void>,
): Promise<void> => {
  if (repairLegacySchemaRenames) {
    logDebug(
      "Migration",
      "Step 0: repairing legacy schema renames before schema apply...",
    );
    // Must run BEFORE applySchemaChanges(): the declarative apply would create
    // empty target tables and columns first, leaving legacy data behind.
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
