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
import { executeBatch, getDb, queryAll } from "#shared/db/client.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  resetDatabase,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import { requireEnv } from "#shared/env.ts";
import { listFiles, uploadRaw } from "#shared/storage.ts";

// ─── Types ──────────────────────────────────────────────────────

type ColumnInfo = { name: string; type: string };
type TableNameRow = { name: string };

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

/** Double-quote a SQL identifier (table or column name) */
const quoteId = (name: string): string => `"${name}"`;

/** Get column info for a table */
const getColumns = (table: string): Promise<ColumnInfo[]> =>
  queryAll<ColumnInfo>(`PRAGMA table_info(${quoteId(table)})`);

/** Get existing table names in one round-trip. */
const getExistingTableNames = async (): Promise<Set<string>> => {
  const rows = await queryAll<TableNameRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  return new Set(rows.map((row) => row.name));
};

/** Escape a SQL string value (single quotes doubled) */
const escapeSql = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

/**
 * Split SQL text into individual statements.
 * Splits on ";\n" boundaries, which is the format produced by exportTable.
 */
export const splitStatements = (sql: string): string[] => {
  if (sql.trim() === "") return [];
  return sql
    .replace(/\r\n/g, "\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => (s.endsWith(";") ? s : `${s};`));
};

/** Check if DB_URL points to a remote database */
export const isRemoteDatabase = (): boolean => {
  const url = requireEnv("DB_URL");
  return url.startsWith("libsql://") || url.startsWith("https://");
};

/**
 * Extract a short database name from DB_URL for use in backup filenames.
 * e.g. "libsql://01KFXB...-tickets-spencer.lite.bunnydb.net/" → "tickets-spencer"
 * Falls back to "local" for non-remote or unparseable URLs.
 */
export const dbName = (): string => {
  const url = requireEnv("DB_URL");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "local";
  }
  // "01KFXB...-tickets-spencer.lite.bunnydb.net" → "01KFXB...-tickets-spencer"
  const first = host.split(".")[0]!;
  // Drop the leading ID chunk (before first hyphen)
  const dashIdx = first.indexOf("-");
  if (dashIdx === -1) return first;
  return first.slice(dashIdx + 1);
};

// ─── Backup ─────────────────────────────────────────────────────

/** Export a single table as INSERT statements (deterministic row order) */
export const exportTable = async (table: string): Promise<string> => {
  const columns = await getColumns(table);
  const colNames = pipe(map((c: ColumnInfo) => c.name))(columns);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM ${quoteId(table)} ORDER BY rowid`,
  );

  if (rows.length === 0) return "";

  const quotedTable = quoteId(table);
  const quotedCols = pipe(map(quoteId))(colNames);
  const lines: string[] = [];
  for (const row of rows) {
    const values = pipe(map((col: string) => escapeSql(row[col])))(colNames);
    lines.push(
      `INSERT INTO ${quotedTable} (${quotedCols.join(", ")}) VALUES (${values.join(
        ", ",
      )});`,
    );
  }
  return lines.join("\n");
};

/** Create a full backup — one TableBackup per table in SCHEMA order.
 *  Skips tables that don't exist yet (e.g. new tables about to be created by a migration). */
export const createBackup = async (): Promise<TableBackup[]> => {
  const existingTables = await getExistingTableNames();
  const tables = SCHEMA_TABLE_NAMES.filter((table) =>
    existingTables.has(table),
  );
  const backups: TableBackup[] = [];

  const concurrency = 4;
  for (let i = 0; i < tables.length; i += concurrency) {
    const chunk = tables.slice(i, i + concurrency);
    backups.push(
      ...(await Promise.all(
        chunk.map(async (table) => ({ sql: await exportTable(table), table })),
      )),
    );
  }
  return backups;
};

/** Generate a timestamped backup filename scoped to the current DB */
export const backupFilename = (timestamp: string): string =>
  `backup-${dbName()}-${timestamp}.zip`;

/** Generate a timestamp string for backup filenames */
export const backupTimestamp = (date = new Date()): string =>
  date.toISOString().replace(/[:.]/g, "-");

/** Build the manifest object for a backup */
const buildManifest = (
  tables: TableBackup[],
  timestamp: string,
): BackupManifest => ({
  latestUpdate: LATEST_UPDATE,
  schemaHash: SCHEMA_HASH,
  tables: Object.fromEntries(
    tables.map(({ table, sql }) => [
      table,
      sql === "" ? 0 : sql.split("\n").length,
    ]),
  ),
  timestamp,
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
  return zipSync(files, { level: 1 });
};

/** Create a backup zip and upload it to storage. Returns the filename. */
export const createAndUploadBackup = async (): Promise<string> => {
  const timestamp = backupTimestamp();
  const zipData = await createBackupZip();
  const filename = backupFilename(timestamp);
  await uploadRaw(zipData, filename);
  return filename;
};

/** Prefix for listing backups scoped to the current DB */
export const backupPrefix = (): string => `backup-${dbName()}-`;

/**
 * A backup younger than this is reused rather than recreated. Migrations can
 * retry after a crash (the lock self-heals via TTL), so this avoids piling up
 * near-identical pre-migration backups on each retry.
 */
export const BACKUP_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * Parse the epoch-ms encoded in a backup filename, or null if it doesn't match.
 * Inverse of backupTimestamp: "...-2024-01-15T12-30-00-000Z.zip" → epoch ms.
 */
export const parseBackupTime = (filename: string): number | null => {
  const m = filename.match(
    /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$/,
  );
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
};

/** True if a backup younger than BACKUP_FRESHNESS_WINDOW_MS already exists */
export const hasRecentBackup = async (): Promise<boolean> => {
  const now = Date.now();
  const files = await listFiles(backupPrefix());
  for (const file of files) {
    const ms = parseBackupTime(file);
    if (ms !== null && now - ms < BACKUP_FRESHNESS_WINDOW_MS) return true;
  }
  return false;
};

// ─── Restore ────────────────────────────────────────────────────

/** Validate that a parsed object has the expected BackupManifest shape */
const isValidManifest = (v: unknown): v is BackupManifest =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Record<string, unknown>).schemaHash === "string" &&
  typeof (v as Record<string, unknown>).latestUpdate === "string" &&
  typeof (v as Record<string, unknown>).timestamp === "string" &&
  typeof (v as Record<string, unknown>).tables === "object" &&
  (v as Record<string, unknown>).tables !== null;

/** Read and parse manifest.json from a backup zip. Returns null if missing or invalid. */
export const readManifest = (zipData: Uint8Array): BackupManifest | null => {
  const files = unzipSync(zipData);
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) return null;
  const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  return isValidManifest(parsed) ? parsed : null;
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
  await initDb({ allowMissingSettings: true });

  // initDb writes migration markers into settings/schema_migrations; clear them
  // so the backup's own rows don't collide on primary keys.
  await getDb().execute("DELETE FROM settings");
  await getDb().execute("DELETE FROM schema_migrations");

  const statements = splitStatements(sql);
  if (statements.length > 0) {
    await executeBatch(statements.map((s) => ({ args: [], sql: s })));
  }

  // The markers now come from the backup and may predate the current schema;
  // drop the "ready" cache so the next initDb re-checks and migrates if needed.
  invalidateInitDbCache();
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
