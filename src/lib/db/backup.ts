/**
 * Database backup and restore — exports each table as SQL statements
 * and restores by dropping all tables and replaying SQL files.
 *
 * Backups are stored unencrypted on the configured storage backend
 * (the sensitive data inside is already encrypted at the field level).
 */

import { map, pipe } from "#fp";
import { getDb, queryAll } from "#lib/db/client.ts";
import { initDb, resetDatabase } from "#lib/db/migrations.ts";
import { getEnv } from "#lib/env.ts";

// ─── Types ──────────────────────────────────────────────────────

type TableInfo = { name: string };
type ColumnInfo = { name: string; type: string };

/** A single table's backup: table name and the SQL to recreate + repopulate it */
export type TableBackup = {
  table: string;
  sql: string;
};

// ─── Helpers ────────────────────────────────────────────────────

/** List all user-created tables (excludes sqlite internals) */
export const listTables = async (): Promise<string[]> => {
  const rows = await queryAll<TableInfo>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream_%' ORDER BY name",
  );
  return pipe(map((r: TableInfo) => r.name))(rows);
};

/** Get column info for a table */
const getColumns = (table: string): Promise<ColumnInfo[]> =>
  queryAll<ColumnInfo>(`PRAGMA table_info(${table})`);

/** Escape a SQL string value (single quotes doubled) */
const escapeSql = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

/** Check if DB_URL points to a remote database */
export const isRemoteDatabase = (): boolean => {
  const url = getEnv("DB_URL") ?? "";
  return url.startsWith("libsql://") || url.startsWith("https://");
};

// ─── Backup ─────────────────────────────────────────────────────

/** Export a single table as INSERT statements */
export const exportTable = async (table: string): Promise<string> => {
  const columns = await getColumns(table);
  const colNames = pipe(map((c: ColumnInfo) => c.name))(columns);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM ${table}`,
  );

  if (rows.length === 0) return "";

  const lines: string[] = [];
  for (const row of rows) {
    const values = pipe(map((col: string) => escapeSql(row[col])))(colNames);
    lines.push(
      `INSERT INTO ${table} (${colNames.join(", ")}) VALUES (${
        values.join(", ")
      });`,
    );
  }
  return lines.join("\n");
};

/** Create a full backup — one TableBackup per table */
export const createBackup = async (): Promise<TableBackup[]> => {
  const tables = await listTables();
  const backups: TableBackup[] = [];
  for (const table of tables) {
    const sql = await exportTable(table);
    backups.push({ table, sql });
  }
  return backups;
};

/** Generate a timestamped backup filename */
export const backupFilename = (table: string, timestamp: string): string =>
  `backup-${timestamp}-${table}.sql`;

/** Generate a timestamp string for backup filenames */
export const backupTimestamp = (): string =>
  new Date().toISOString().replace(/[:.]/g, "-");

// ─── Restore ────────────────────────────────────────────────────

/**
 * Restore the database from SQL content.
 * Drops all tables, reinitializes the schema, then executes the SQL statements.
 */
export const restoreFromSql = async (sql: string): Promise<void> => {
  await resetDatabase();
  await initDb();

  const statements = sql
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"));

  const db = getDb();
  for (const stmt of statements) {
    await db.execute(stmt);
  }
};
