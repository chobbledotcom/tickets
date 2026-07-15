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
import { chunk, requiredMapValue } from "#fp";
import {
  backupKey,
  backupTimestamp,
  pruneOldBackups,
} from "#shared/db/backup-storage.ts";
import {
  executeBatch,
  queryAll,
  queryBatch,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import {
  clearAllCaches,
  LATEST_UPDATE,
  rebuildWipedSchema,
  resetDatabase,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import { queryColumnSet } from "#shared/db/query.ts";
import {
  dumpMigrationState,
  legacyColumnRestores,
} from "#shared/db/restore-legacy-columns.ts";
import { readLimit } from "#shared/limits.ts";
import { namedError } from "#shared/named-error.ts";
import { nowIso } from "#shared/now.ts";
import { uploadRaw } from "#shared/storage.ts";

/** Thrown by restoreFromSql after resetDatabase() runs but a later step fails,
 *  so callers can distinguish a post-reset failure (DB wiped) from a pre-reset
 *  validation error (DB intact). */
export class PostResetError extends namedError("PostResetError") {}

// ─── Types ──────────────────────────────────────────────────────

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
  const timestamp = nowIso();
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
 *
 * Refuses a dump from a newer build BEFORE wiping anything: replaying it here
 * would silently discard newer-schema data (tables this build's schema lacks
 * are skipped), making an accidental rollback look like a successful restore.
 */
export const restoreFromSql = async (sql: string): Promise<void> => {
  const statements = splitStatements(sql);
  const migrations = dumpMigrationState(statements, MIGRATION_IDS);
  if (migrations.fromNewerBuild.length > 0) {
    throw new Error(
      "Backup is from a newer version of the app: it records migration(s) " +
        `newer than this build knows (${migrations.fromNewerBuild.join(", ")}). ` +
        "Update the site to that version or newer, then restore this backup.",
    );
  }

  // Capture any failure and re-throw as PostResetError outside the catch to
  // avoid V8 coverage gaps on `throw` inside catch blocks for async functions.
  // resetDatabase() is inside the try so that partial-drop failures (e.g. the
  // sessions table already removed) are also routed as post-reset errors.
  let postResetErr: string | undefined;
  try {
    await resetDatabase();
    // The database was just wiped, so rebuild the schema with unconditional
    // IF NOT EXISTS creates. Never consult the database here — neither
    // initDb's state check nor a live-schema snapshot: right after the drops,
    // a replica and even the primary can briefly serve the pre-wipe schema
    // (read-your-writes lag), and a stale answer either routed boot into
    // schema verification against the wiped primary ("missing table
    // settings") or skipped the CREATEs and died at the import ("no such
    // table: settings").
    await rebuildWipedSchema();

    // Roll the seed-data deletes into the same executeBatch transaction as the
    // import so that a failed import rolls the deletes back too, leaving the DB
    // in the clean post-initDb state rather than a mix of empty seed tables and
    // partially applied backup rows. Columns the dump writes that a migration
    // the backup predates has since dropped are re-added first, so the replayed
    // rows land intact for that pending migration to reshape on the next boot
    // (see restore-legacy-columns.ts) — but only when the dump actually has
    // pending migrations to consume them: with none pending, an unknown column
    // is corruption, and the INSERT must fail loudly instead.
    await executeBatch(
      [
        "DELETE FROM settings",
        "DELETE FROM schema_migrations",
        "DELETE FROM attendee_statuses",
        ...(migrations.hasPending ? legacyColumnRestores(statements) : []),
        ...statements,
      ].map((s) => ({ args: [], sql: s })),
    );

    // Clear all module-level caches — the backup may carry different data for
    // every table, so any warm cache is now stale. clearAllCaches() covers the
    // same set as resetDatabase()'s finally block, including caches (holidays,
    // logistics-agents, sessions, settings) that a partial list would miss.
    clearAllCaches();
  } catch (err) {
    postResetErr = String(err);
  }
  if (postResetErr !== undefined) {
    throw new PostResetError(postResetErr);
  }
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
