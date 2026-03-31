/**
 * Database backup and restore — exports all tables as a single .zip archive
 * containing one .sql file per table plus a manifest.json with metadata.
 *
 * Key design decisions:
 * - Tables are exported/restored in SCHEMA order (FK-dependency safe)
 * - Restore runs all INSERTs in a single transaction via executeBatch
 * - SQL statements are delimited by ";\n" to handle embedded newlines in values
 * - Backups are stored unencrypted (sensitive data is already field-level encrypted)
 * - manifest.json enables preflight schema compatibility checks before restore
 */

import { unzipSync, zipSync } from "fflate";
import { map, pipe } from "#fp";
import { executeBatch, queryAll } from "#lib/db/client.ts";
import {
  initDb,
  LATEST_UPDATE,
  resetDatabase,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#lib/db/migrations.ts";
import { getEnv } from "#lib/env.ts";

// ─── Types ──────────────────────────────────────────────────────

type ColumnInfo = { name: string; type: string };

/** A single table's backup: table name and the SQL to recreate + repopulate it */
export type TableBackup = {
  table: string;
  sql: string;
};

/** Metadata stored in manifest.json inside the backup zip */
export type BackupManifest = {
  schemaHash: string;
  latestUpdate: string;
  timestamp: string;
  tables: Record<string, number>;
};

// ─── Helpers ────────────────────────────────────────────────────

/** Get column info for a table */
const getColumns = (table: string): Promise<ColumnInfo[]> =>
  queryAll<ColumnInfo>(`PRAGMA table_info(${table})`);

/** Escape a SQL string value (single quotes doubled) */
const escapeSql = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

/**
 * Split SQL text into individual statements.
 * Statements are delimited by ";" at end-of-line (or end-of-string).
 * Skips empty lines and SQL comments.
 */
export const splitStatements = (sql: string): string[] =>
  sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("--"))
    .map((s) => (s.endsWith(";") ? s : `${s};`));

/** Check if DB_URL points to a remote database */
export const isRemoteDatabase = (): boolean => {
  const url = getEnv("DB_URL") ?? "";
  return url.startsWith("libsql://") || url.startsWith("https://");
};

// ─── Backup ─────────────────────────────────────────────────────

/** Export a single table as INSERT statements (deterministic row order) */
export const exportTable = async (table: string): Promise<string> => {
  const columns = await getColumns(table);
  const colNames = pipe(map((c: ColumnInfo) => c.name))(columns);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM ${table} ORDER BY rowid`,
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

/** Create a full backup — one TableBackup per table in SCHEMA order */
export const createBackup = async (): Promise<TableBackup[]> => {
  const backups: TableBackup[] = [];
  for (const table of SCHEMA_TABLE_NAMES) {
    const sql = await exportTable(table);
    backups.push({ table, sql });
  }
  return backups;
};

/** Generate a timestamped backup filename */
export const backupFilename = (timestamp: string): string =>
  `backup-${timestamp}.zip`;

/** Generate a timestamp string for backup filenames */
export const backupTimestamp = (): string =>
  new Date().toISOString().replace(/[:.]/g, "-");

/** Build the manifest object for a backup */
const buildManifest = (
  tables: TableBackup[],
  timestamp: string,
): BackupManifest => ({
  schemaHash: SCHEMA_HASH,
  latestUpdate: LATEST_UPDATE,
  timestamp,
  tables: Object.fromEntries(
    tables.map(({ table, sql }) => [
      table,
      sql === "" ? 0 : sql.split("\n").length,
    ]),
  ),
});

/** Create a zip archive from table backups with manifest */
export const createBackupZip = async (): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const timestamp = new Date().toISOString();
  const tables = await createBackup();
  const manifest = buildManifest(tables, timestamp);

  const files: Record<string, Uint8Array> = {
    "manifest.json": encoder.encode(JSON.stringify(manifest, null, 2)),
  };
  for (const { table, sql } of tables) {
    files[`${table}.sql`] = encoder.encode(sql);
  }
  return zipSync(files);
};

// ─── Restore ────────────────────────────────────────────────────

/** Read and parse manifest.json from a backup zip. Returns null if missing. */
export const readManifest = (zipData: Uint8Array): BackupManifest | null => {
  const files = unzipSync(zipData);
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) return null;
  return JSON.parse(new TextDecoder().decode(manifestBytes));
};

/** Count SQL statements across all .sql files in a zip archive */
export const countZipStatements = (zipData: Uint8Array): number => {
  const files = unzipSync(zipData);
  const decoder = new TextDecoder();
  let count = 0;
  for (const name of Object.keys(files)) {
    if (!name.endsWith(".sql")) continue;
    const content = decoder.decode(files[name]!);
    if (content.trim() === "") continue;
    count += splitStatements(content).length;
  }
  return count;
};

/**
 * Restore the database from SQL content.
 * Drops all tables, reinitializes the schema, then executes all SQL
 * statements in a single transaction via executeBatch.
 */
export const restoreFromSql = async (sql: string): Promise<void> => {
  await resetDatabase();
  await initDb();

  const statements = splitStatements(sql);
  if (statements.length === 0) return;

  await executeBatch(statements.map((s) => ({ sql: s, args: [] })));
};

/**
 * Restore the database from a zip archive.
 * Files are replayed in SCHEMA order (FK-dependency safe), not alphabetically.
 */
export const restoreFromZip = async (zipData: Uint8Array): Promise<void> => {
  const files = unzipSync(zipData);
  const decoder = new TextDecoder();
  const allSql: string[] = [];

  // Iterate in SCHEMA order for FK safety
  for (const table of SCHEMA_TABLE_NAMES) {
    const content = files[`${table}.sql`];
    if (content) allSql.push(decoder.decode(content));
  }

  await restoreFromSql(allSql.join("\n"));
};
