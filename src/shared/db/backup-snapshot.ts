import { chunk, requiredMapValue } from "#fp";
import {
  queryAllPrimary,
  queryBatchPrimary,
  queryOnePrimary,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import { SCHEMA_TABLE_NAMES } from "#shared/db/migrations.ts";
import { readLimit } from "#shared/limits.ts";

/** A single table's backup: its name, repopulating SQL, and row count. */
export type TableBackup = {
  table: string;
  sql: string;
  rowCount: number;
};

export type BackupCapture = {
  checkoutStageRevision?: { revision: number };
  tables: TableBackup[];
};

/** Double-quote a trusted SQL identifier. */
export const quoteSqlIdentifier = (name: string): string => `"${name}"`;

const existingSchemaTables = async (): Promise<string[]> => {
  const rows = await queryAllPrimary<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
    [],
  );
  const existing = new Set(rows.map((row) => row.name));
  return SCHEMA_TABLE_NAMES.filter((table) => existing.has(table));
};

const escapeSql = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

const ROWS_PER_INSERT = 100;
const DEFAULT_BACKUP_PAGE_SIZE = 500;
const ROWID_ALIAS = "__backup_rowid__";
type BackupRow = Record<string, unknown>;

const tablePageStatement = (
  table: string,
  cursor: number,
  pageSize: number,
): SqlStatement => ({
  args: [cursor, pageSize],
  sql:
    `SELECT rowid AS ${ROWID_ALIAS}, * FROM ${quoteSqlIdentifier(table)} ` +
    "WHERE rowid > ? ORDER BY rowid LIMIT ?",
});

/** Export one table in deterministic, primary-pinned keyset pages. */
export const exportTable = async (
  table: string,
  pageSize: number = readLimit("BACKUP_PAGE_SIZE", DEFAULT_BACKUP_PAGE_SIZE),
  firstPage?: BackupRow[],
): Promise<{ sql: string; rowCount: number }> => {
  const quoted = quoteSqlIdentifier(table);
  const statements: string[] = [];
  let rowCount = 0;
  let cols: string[] = [];
  let colList = "";
  const tuple = (row: Record<string, unknown>): string =>
    `(${cols.map((column) => escapeSql(row[column])).join(", ")})`;
  let cursor = 0;
  let suppliedPage = firstPage;

  for (;;) {
    const rows =
      suppliedPage ??
      (await queryAllPrimary<BackupRow>(
        tablePageStatement(table, cursor, pageSize).sql,
        [cursor, pageSize],
      ));
    suppliedPage = undefined;
    if (rows.length === 0) break;
    if (rowCount === 0) {
      cols = Object.keys(rows[0]!).filter((column) => column !== ROWID_ALIAS);
      colList = cols.map(quoteSqlIdentifier).join(", ");
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

const exportTables = async (tables: string[]): Promise<TableBackup[]> => {
  const pageSize = readLimit("BACKUP_PAGE_SIZE", DEFAULT_BACKUP_PAGE_SIZE);
  const firstPages = await queryBatchPrimary(
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

/** Complete bounded exports attempted before continuous writes abort capture. */
export const BACKUP_CAPTURE_ATTEMPTS = 3;

const checkoutStageRevision = async (): Promise<number> =>
  (
    await queryOnePrimary<{ revision: number }>(
      "SELECT revision FROM checkout_stage_revisions WHERE id = 1",
      [],
    )
  )?.revision ?? 0;

/** Capture without a long transaction. Equal revisions before and after the
 * bounded export certify that no stage mutation split the related tables. */
export const captureBackup = async (): Promise<BackupCapture> => {
  for (let attempt = 0; attempt < BACKUP_CAPTURE_ATTEMPTS; attempt += 1) {
    const tables = await existingSchemaTables();
    if (!tables.includes("checkout_stages")) {
      return { tables: await exportTables(tables) };
    }
    const before = await checkoutStageRevision();
    const exported = await exportTables(tables);
    const after = await checkoutStageRevision();
    if (before === after) {
      return {
        checkoutStageRevision: { revision: after },
        tables: exported,
      };
    }
  }
  throw new Error(
    `Checkout stages kept changing during backup after ${BACKUP_CAPTURE_ATTEMPTS} attempts`,
  );
};
