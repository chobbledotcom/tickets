import { chunk, requiredMapValue, sumOf } from "#fp";
import {
  queryAll,
  queryBatch,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import { SCHEMA_TABLE_NAMES } from "#shared/db/migrations.ts";
import { queryColumnSet } from "#shared/db/query.ts";
import { readLimit } from "#shared/limits.ts";

/** A single table's backup: table name, the SQL to repopulate it, and row count */
export type TableBackup = {
  table: string;
  sql: string;
  rowCount: number;
};

/** Double-quote a SQL identifier (table or column name) */
const quoteId = (name: string): string => `"${name}"`;

/** Get existing table names in one round-trip. */
const getExistingTableNames = (): Promise<Set<string>> =>
  queryColumnSet("SELECT name FROM sqlite_master WHERE type = 'table'", "name");

/**
 * The schema's tables that currently exist, in SCHEMA (FK-dependency) order.
 * Skips tables a pending migration has not created yet.
 */
const existingSchemaTables = async (): Promise<string[]> => {
  const existing = await getExistingTableNames();
  return SCHEMA_TABLE_NAMES.filter((table) => existing.has(table));
};

/** Escape a SQL string value (single quotes doubled) */
const escapeSql = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

/** Max rows per multi-row INSERT. Batching writes the column list and statement
 *  prefix once per group instead of once per row, shrinking the dump and
 *  cutting the number of statements replayed on restore. */
const ROWS_PER_INSERT = 100;

/**
 * Rows fetched per keyset page when exporting a table. A whole-table
 * `SELECT *` makes libsqld (the server behind Bunny's databases) serialize the
 * entire result into one response, which trips its "Response is too large"
 * payload cap on big tables. Paging by rowid keeps each read's response
 * bounded. Overridable per call (tests) and via the `BACKUP_PAGE_SIZE` env var.
 */
const DEFAULT_BACKUP_PAGE_SIZE = 500;

/** Result-set key carrying the keyset cursor (rowid); stripped from the dump. */
const ROWID_ALIAS = "__backup_rowid__";

type BackupRow = Record<string, unknown>;

const tablePageStatement = (
  table: string,
  cursor: number,
  pageSize: number,
): SqlStatement => ({
  args: [cursor, pageSize],
  sql:
    `SELECT rowid AS ${ROWID_ALIAS}, * FROM ${quoteId(table)} ` +
    "WHERE rowid > ? ORDER BY rowid LIMIT ?",
});

/** Export a single table as multi-row INSERT statements (deterministic order).
 *  Reads are keyset-paginated by rowid so no single response exceeds libsqld's
 *  payload cap. Column names come from the row keys (minus the cursor alias),
 *  so no extra schema query is needed. */
export const exportTable = async (
  table: string,
  pageSize: number = readLimit("BACKUP_PAGE_SIZE", DEFAULT_BACKUP_PAGE_SIZE),
  firstPage?: BackupRow[],
): Promise<{ sql: string; rowCount: number }> => {
  const quoted = quoteId(table);
  const statements: string[] = [];
  let rowCount = 0;
  let cols: string[] = [];
  let colList = "";
  const tuple = (row: Record<string, unknown>): string =>
    `(${cols.map((c) => escapeSql(row[c])).join(", ")})`;
  // App invariant: every table's rowids are positive autoincrement ids, so a
  // cursor starting below 1 reads the whole table.
  let cursor = 0;
  let suppliedPage = firstPage;

  for (;;) {
    const rows =
      suppliedPage ??
      (await queryAll<BackupRow>(
        tablePageStatement(table, cursor, pageSize).sql,
        [cursor, pageSize],
      ));
    suppliedPage = undefined;
    if (rows.length === 0) break;
    if (rowCount === 0) {
      cols = Object.keys(rows[0]!).filter((c) => c !== ROWID_ALIAS);
      colList = cols.map(quoteId).join(", ");
    }
    for (const group of chunk(ROWS_PER_INSERT)(rows)) {
      statements.push(
        `INSERT INTO ${quoted} (${colList}) VALUES ${group
          .map(tuple)
          .join(", ")};`,
      );
    }
    rowCount += rows.length;
    cursor = Number(rows[rows.length - 1]![ROWID_ALIAS]);
    if (rows.length < pageSize) break;
  }
  return { rowCount, sql: statements.join("\n") };
};

/** Row counts for every schema table, in SCHEMA order, in one round trip. */
export const countSchemaTableRows = async (): Promise<number[]> => {
  const results = await queryBatch(
    SCHEMA_TABLE_NAMES.map((table) => ({
      args: [],
      sql: `SELECT count(*) AS rowCount FROM ${quoteId(table)}`,
    })),
  );
  // count(*) always returns exactly one row per statement.
  return results.map(
    (result) => resultRows<{ rowCount: number }>(result)[0]!.rowCount,
  );
};

/** Database round trips a full dump makes for these row counts: one to list
 *  the tables, one batched first page for every table, then one extra read
 *  per additional page of a table that spills past its first. */
export const backupDumpDatabaseCalls = (
  rowCounts: number[],
  pageSize: number = readLimit("BACKUP_PAGE_SIZE", DEFAULT_BACKUP_PAGE_SIZE),
): number =>
  2 + sumOf((rows: number) => Math.floor(rows / pageSize))(rowCounts);

/** Create a full backup — one TableBackup per table in SCHEMA order.
 *  Skips tables that don't exist yet (e.g. new tables about to be created by a migration). */
export const createBackup = async (): Promise<TableBackup[]> => {
  const tables = await existingSchemaTables();
  const pageSize = readLimit("BACKUP_PAGE_SIZE", DEFAULT_BACKUP_PAGE_SIZE);
  const firstPages = await queryBatch(
    tables.map((table) => tablePageStatement(table, 0, pageSize)),
  );
  const pagesByIndex = new Map(firstPages.entries());
  return Promise.all(
    tables.map(async (table, index) => ({
      table,
      ...(await exportTable(
        table,
        pageSize,
        resultRows<BackupRow>(
          requiredMapValue(
            pagesByIndex,
            index,
            `Backup page missing for ${table}`,
          ),
        ),
      )),
    })),
  );
};
