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
import { chunk, compact } from "#fp";
import { execute, executeBatch, queryAll } from "#shared/db/client.ts";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  resetDatabase,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { requireEnv } from "#shared/env.ts";
import { MAX_BACKUPS, readLimit } from "#shared/limits.ts";
import {
  deleteFile,
  getBasename,
  listFiles,
  uploadRaw,
} from "#shared/storage.ts";

// ─── Types ──────────────────────────────────────────────────────

type TableNameRow = { name: string };

/** A single table's backup: table name, the SQL to repopulate it, and row count */
export type TableBackup = {
  table: string;
  sql: string;
  rowCount: number;
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

/** Get existing table names in one round-trip. */
const getExistingTableNames = async (): Promise<Set<string>> => {
  const rows = await queryAll<TableNameRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  return new Set(rows.map((row) => row.name));
};

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
 * For Turso URLs the full first hostname segment is used as-is (it is already
 * the unique database identity: "{db-name}-{org}.turso.io").
 * Falls back to "local" for non-remote or unparseable URLs.
 */
export const dbName = (url: string = requireEnv("DB_URL")): string => {
  if (!URL.canParse(url)) return "local";

  const host = new URL(url).hostname;
  const first = host.split(".")[0]!;

  // Turso hostnames: {db-name}-{org}.turso.io — the full first segment is unique
  if (host.endsWith(".turso.io")) return first;

  // Bunny DB hostnames: {uuid}-{name}.lite.bunnydb.net — drop the UUID prefix
  const dashIdx = first.indexOf("-");
  if (dashIdx === -1) return first;
  return first.slice(dashIdx + 1);
};

// ─── Backup ─────────────────────────────────────────────────────

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

/** Export a single table as multi-row INSERT statements (deterministic order).
 *  Reads are keyset-paginated by rowid so no single response exceeds libsqld's
 *  payload cap. Column names come from the row keys (minus the cursor alias),
 *  so no extra schema query is needed. */
export const exportTable = async (
  table: string,
  pageSize: number = readLimit("BACKUP_PAGE_SIZE", DEFAULT_BACKUP_PAGE_SIZE),
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

  for (;;) {
    const rows = await queryAll<Record<string, unknown>>(
      `SELECT rowid AS ${ROWID_ALIAS}, * FROM ${quoted} ` +
        "WHERE rowid > ? ORDER BY rowid LIMIT ?",
      [cursor, pageSize],
    );
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

/** Create a full backup — one TableBackup per table in SCHEMA order.
 *  Skips tables that don't exist yet (e.g. new tables about to be created by a migration). */
export const createBackup = async (): Promise<TableBackup[]> => {
  const tables = await existingSchemaTables();
  const backups: TableBackup[] = [];

  const concurrency = 4;
  for (let i = 0; i < tables.length; i += concurrency) {
    const batch = tables.slice(i, i + concurrency);
    backups.push(
      ...(await Promise.all(
        batch.map(async (table) => ({
          table,
          ...(await exportTable(table)),
        })),
      )),
    );
  }
  return backups;
};

/**
 * Per-site folder that scopes a database's backups within shared storage
 * (defaults to the current DB; pass a name from `dbName(url)` to target another
 * instance). Because it is a real path segment — not a name prefix — listing one
 * site's folder can never pick up another's, even when one db name is a string
 * prefix of another ("tickets" vs "tickets-spencer").
 */
export const backupDir = (name: string = dbName()): string => `${name}/`;

/** Leaf filename for a backup taken at `timestamp`, e.g.
 *  "backup-2024-01-15T12-30-00-000Z.zip". Lives inside `backupDir()`. */
export const backupLeaf = (timestamp: string): string =>
  `backup-${timestamp}.zip`;

/** Full storage key for a backup: "{name}/backup-{timestamp}.zip". Defaults to
 *  the current DB; pass a name to target another instance. */
export const backupKey = (timestamp: string, name: string = dbName()): string =>
  `${backupDir(name)}${backupLeaf(timestamp)}`;

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
    tables.map(({ table, rowCount }) => [table, rowCount]),
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

/** Create a backup zip and upload it to storage. Returns the filename.
 *  Purges the oldest backups beyond MAX_BACKUPS after a successful upload. */
export const createAndUploadBackup = async (): Promise<string> => {
  const timestamp = backupTimestamp();
  const zipData = await createBackupZip();
  const filename = backupKey(timestamp);
  await uploadRaw(zipData, filename);
  await pruneOldBackups();
  return filename;
};

/**
 * How fresh a backup must be to satisfy the pre-upgrade gate on /admin/update
 * and the per-site update button — updates are blocked unless a backup for that
 * database was taken within this window. One hour.
 */
export const BACKUP_REQUIRED_WITHIN_MS = 60 * 60 * 1000;

/** ISO-8601-ish timestamp as it appears in a backup filename (":"/"." → "-"),
 *  with the date/time pieces captured so parseBackupTime can rebuild the real
 *  ISO string. Defined once and reused by every backup-filename matcher. */
const BACKUP_TIMESTAMP = String.raw`(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z`;

/** Matches the "{timestamp}.zip" tail at the end of a backup key. */
const BACKUP_TIME_TAIL = new RegExp(`${BACKUP_TIMESTAMP}\\.zip$`);

/** Matches a leaf that is *exactly* "backup-{timestamp}.zip" — no directory and
 *  no extra characters, so it also rejects any path separators. */
const BACKUP_LEAF = new RegExp(`^backup-${BACKUP_TIMESTAMP}\\.zip$`);

/**
 * Parse the epoch-ms encoded in a backup filename, or null if it doesn't match.
 * Inverse of backupTimestamp: "…/backup-2024-01-15T12-30-00-000Z.zip" → epoch ms.
 */
export const parseBackupTime = (filename: string): number | null => {
  const m = filename.match(BACKUP_TIME_TAIL);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
};

/** True when a bare leaf name is exactly "backup-{timestamp}.zip". Anchored, so
 *  it also doubles as traversal-proofing for the download route's filename. */
export const isBackupLeaf = (leaf: string): boolean => BACKUP_LEAF.test(leaf);

/** True when a storage key ("{name}/backup-…zip") is one of our backups — i.e.
 *  its leaf is a valid backup filename. Picks backups out of a folder listing
 *  while ignoring anything else stored alongside them. */
export const isBackupPath = (key: string): boolean =>
  isBackupLeaf(getBasename(key));

/**
 * True if a backup younger than `maxAgeMs` exists for the given database
 * (defaults to the current DB) within the upgrade-gate window. Callers gating
 * another instance pass `dbName(site.dbUrl)`.
 */
export const hasRecentBackup = async (
  maxAgeMs: number = BACKUP_REQUIRED_WITHIN_MS,
  name: string = dbName(),
): Promise<boolean> => {
  const now = Date.now();
  const files = await listFiles(backupDir(name));
  for (const file of files) {
    // Only real backups count — ignore anything else left in the folder, so a
    // stray "{name}/manual-…Z.zip" can't spoof the freshness gate (mirrors
    // pruneOldBackups).
    if (!isBackupPath(file)) continue;
    const ms = parseBackupTime(file);
    if (ms !== null && now - ms < maxAgeMs) return true;
  }
  return false;
};

/**
 * Purge the oldest backups beyond `keep` for the current DB, keeping the
 * newest. Filenames embed ISO timestamps, so name order is chronological.
 * Deletes run in parallel and are best-effort — a failed delete never blocks
 * backup creation. Returns the filenames that were removed.
 */
export const pruneOldBackups = async (
  keep = MAX_BACKUPS,
): Promise<string[]> => {
  const files = await listFiles(backupDir());
  const stale = files.filter(isBackupPath).reverse().slice(keep);
  const removed = await Promise.all(
    stale.map(async (file) => {
      try {
        await deleteFile(file);
        return file;
      } catch {
        return null;
      }
    }),
  );
  return compact(removed);
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

  // initDb writes migration markers into settings/schema_migrations and seeds a
  // default attendee_statuses row; clear them so the backup's own rows don't
  // collide on primary keys. (An older backup with no attendee_statuses rows
  // re-seeds on the next initDb, which runs because the markers are cleared.)
  await execute("DELETE FROM settings");
  await execute("DELETE FROM schema_migrations");
  await execute("DELETE FROM attendee_statuses");

  const statements = splitStatements(sql);
  if (statements.length > 0) {
    await executeBatch(statements.map((s) => ({ args: [], sql: s })));
  }

  // The markers now come from the backup and may predate the current schema;
  // drop the "ready" cache so the next initDb re-checks and migrates if needed.
  invalidateInitDbCache();
  // The entity caches persist across requests, so a restore that wholesale-
  // replaces the data would otherwise keep serving the pre-restore snapshot
  // until each cache's TTL. Clear them.
  invalidateListingsCache();
  invalidateGroupsCache();
  invalidateUsersCache();
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
