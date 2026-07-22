/**
 * Database backup and restore — exports all tables as a single .zip archive
 * containing one .sql file per table plus a manifest.json with metadata.
 *
 * Key design decisions:
 * - Tables are exported/restored in SCHEMA order (FK-dependency safe)
 * - Restore uses bounded transactions so large imports do not time out
 * - SQL statements are delimited by ";\n" to handle embedded newlines in values
 * - Backups are stored unencrypted (sensitive data is already field-level encrypted)
 * - manifest.json enables preflight schema compatibility checks before restore
 */

import { unzipSync, zipSync } from "fflate";
import * as v from "valibot";
import { compact, sum } from "#fp";
import { utf8ByteLength } from "#shared/bytes.ts";
import { createBackup, type TableBackup } from "#shared/db/backup-snapshot.ts";
import {
  backupKey,
  backupTimestamp,
  pruneOldBackups,
} from "#shared/db/backup-storage.ts";
import { execute, executeBatch } from "#shared/db/client.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import { SCHEMA } from "#shared/db/migrations/schema/index.ts";
import { TRIGGERS } from "#shared/db/migrations/schema/triggers.ts";
import {
  fullSchemaCreateStatements,
  noArgStatements,
} from "#shared/db/migrations/schema-sync.ts";
import {
  clearAllCaches,
  LATEST_UPDATE,
  rebuildWipedSchema,
  resetDatabase,
  SCHEMA_HASH,
  SCHEMA_TABLE_NAMES,
} from "#shared/db/migrations.ts";
import {
  dumpMigrationState,
  legacyColumnRestores,
} from "#shared/db/restore-legacy-columns.ts";
import { namedError } from "#shared/named-error.ts";
import { nowIso } from "#shared/now.ts";
import { uploadRaw } from "#shared/storage.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/** Thrown by restoreFromSql after resetDatabase() runs but a later step fails,
 *  so callers can distinguish a post-reset failure (DB wiped) from a pre-reset
 *  validation error (DB intact). */
export class PostResetError extends namedError("PostResetError") {}

// ─── Types ──────────────────────────────────────────────────────

/** Metadata stored in manifest.json inside the backup zip. */
const BackupManifestSchema = v.object({
  latestUpdate: v.string(),
  schemaHash: v.string(),
  tables: v.record(v.string(), integerAtLeast(0)),
  timestamp: v.string(),
});

export type BackupManifest = v.InferOutput<typeof BackupManifestSchema>;

export interface BackupInspection {
  manifest: BackupManifest | null;
  statementCount: number;
}

const RESTORE_STAGES = [
  "checking",
  "resetting",
  "rebuilding",
  "importing",
  "clearing-caches",
] as const;

export type RestoreStage = (typeof RESTORE_STAGES)[number];

export interface RestoreProgress {
  stage: RestoreStage;
  statementCount: number;
}

export type RestoreProgressHandler = (progress: RestoreProgress) => void;

const ignoreRestoreProgress: RestoreProgressHandler = () => {};

// Each dump statement already contains up to 100 rows. Keep both the work and
// HTTP body of a remote libSQL transaction bounded while combining enough work
// to avoid one network round trip per statement.
const RESTORE_BATCH_STATEMENT_LIMIT = 50;
const RESTORE_BATCH_BYTE_LIMIT = 512 * 1024;

const restoreBatches = ([first, ...statements]: [
  string,
  ...string[],
]): string[][] => {
  const batches: string[][] = [];
  let current = { bytes: utf8ByteLength(first), statements: [first] };
  for (const statement of statements) {
    const statementBytes = utf8ByteLength(statement);
    if (
      current.statements.length === RESTORE_BATCH_STATEMENT_LIMIT ||
      current.bytes + statementBytes > RESTORE_BATCH_BYTE_LIMIT
    ) {
      batches.push(current.statements);
      current = { bytes: statementBytes, statements: [statement] };
      continue;
    }
    current.statements.push(statement);
    current.bytes += statementBytes;
  }
  batches.push(current.statements);
  return batches;
};

/** Remove write-time schema work while rows are loaded. Backup rows already
 * carry stored totals, and rebuilding indexes after a bulk load is much faster
 * than updating every index once per row. */
const removeIndexesAndTriggers = async (): Promise<void> => {
  const drops = [
    ...SCHEMA.flatMap(([, table]) =>
      (table.indexes ?? []).map(({ name }) => `DROP INDEX IF EXISTS ${name}`),
    ),
    ...TRIGGERS.map(({ name }) => `DROP TRIGGER IF EXISTS ${name}`),
  ];
  await executeBatch(noArgStatements(drops));
};

/** Rebuild deferred indexes one transaction at a time so indexing a populated
 * database cannot turn into one transaction that exceeds libSQL's deadline. */
const rebuildIndexesAndTriggers = async (): Promise<void> => {
  const indexStatements = fullSchemaCreateStatements().filter((sql) =>
    sql.includes(" INDEX IF NOT EXISTS "),
  );
  for (const sql of indexStatements) {
    await executeBatch(noArgStatements([sql]));
  }
  for (const trigger of TRIGGERS) {
    await execute(trigger.sql);
  }
};

interface OpenBackup {
  decoder: TextDecoder;
  files: Record<string, Uint8Array>;
}

const openBackup = (zipData: Uint8Array): OpenBackup => ({
  decoder: new TextDecoder(),
  files: unzipSync(zipData),
});

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Split SQL text into individual statements.
 * Quoted values are consumed as whole tokens, so semicolons in multiline text
 * stay inside their INSERT. Both SQL quote forms escape themselves by doubling.
 */
export const splitStatements = (sql: string): string[] => {
  if (sql.trim() === "") return [];
  const normalized = sql.replace(/\r\n/g, "\n");
  const statements: string[] = [];
  let start = 0;
  const quoteOrStatementEnd = /'(?:''|[^'])*'|"(?:""|[^"])*"|;/gs;

  for (const token of normalized.matchAll(quoteOrStatementEnd)) {
    if (token[0] !== ";") continue;
    const statement = normalized.slice(start, token.index).trim();
    if (statement !== "") statements.push(`${statement};`);
    start = token.index + 1;
  }

  const remainder = normalized.slice(start).trim();
  if (remainder !== "") {
    statements.push(`${remainder};`);
  }
  return statements;
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

/** Read and validate manifest.json. Older backups without one remain restorable. */
const readManifest = (
  files: Record<string, Uint8Array>,
): BackupManifest | null => {
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) return null;
  const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  const result = v.safeParse(BackupManifestSchema, parsed);
  return result.success ? result.output : null;
};

interface InspectedSqlFile {
  statementCount: number;
  table: string;
}

const inspectSqlFiles = ({ decoder, files }: OpenBackup): InspectedSqlFile[] =>
  Object.entries(files)
    .filter(([name]) => name.endsWith(".sql"))
    .map(([name, content]) => ({
      statementCount: splitStatements(decoder.decode(content)).length,
      table: name.slice(0, -4),
    }));

const inspectOpenBackup = (backup: OpenBackup): BackupInspection => {
  const sqlFiles = inspectSqlFiles(backup);
  const unsupported = sqlFiles
    .filter(
      ({ statementCount, table }) =>
        statementCount > 0 && !SCHEMA_TABLE_NAMES.includes(table),
    )
    .map(({ table }) => table);
  if (unsupported.length > 0) {
    throw new Error(
      `Backup contains data for tables this app cannot restore: ${unsupported.join(", ")}`,
    );
  }

  const manifest = readManifest(backup.files);
  const manifestTables = manifest === null ? {} : manifest.tables;
  const statementsByTable = new Map(
    sqlFiles.map(({ statementCount, table }) => [table, statementCount]),
  );
  const missing = Object.entries(manifestTables)
    .filter(
      ([table, rowCount]) => rowCount > 0 && !statementsByTable.get(table),
    )
    .map(([table]) => table);
  if (missing.length > 0) {
    throw new Error(`Backup is missing data for tables: ${missing.join(", ")}`);
  }
  return {
    manifest,
    statementCount: sum(sqlFiles.map((file) => file.statementCount)),
  };
};

/** Read the manifest and count SQL statements in one unzip pass. */
export const inspectBackupZip = (zipData: Uint8Array): BackupInspection =>
  inspectOpenBackup(openBackup(zipData));

/**
 * Restore the database from SQL content.
 * Drops all tables, reinitializes the schema, then executes all SQL
 * statements in bounded sequential transactions.
 *
 * Refuses a dump from a newer build BEFORE wiping anything: replaying it here
 * would silently discard newer-schema data (tables this build's schema lacks
 * are skipped), making an accidental rollback look like a successful restore.
 */
export const restoreFromSql = async (
  sql: string,
  onProgress: RestoreProgressHandler = ignoreRestoreProgress,
): Promise<void> => {
  const statements = splitStatements(sql);
  const report = (stage: RestoreStage): void =>
    onProgress({ stage, statementCount: statements.length });
  report("checking");
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
    report("resetting");
    await resetDatabase();
    // The database was just wiped, so rebuild the schema with unconditional
    // IF NOT EXISTS creates. Never consult the database here — neither
    // initDb's state check nor a live-schema snapshot: right after the drops,
    // a replica and even the primary can briefly serve the pre-wipe schema
    // (read-your-writes lag), and a stale answer either routed boot into
    // schema verification against the wiped primary ("missing table
    // settings") or skipped the CREATEs and died at the import ("no such
    // table: settings").
    report("rebuilding");
    await rebuildWipedSchema();
    await removeIndexesAndTriggers();

    // Columns a pending migration has since dropped are re-added before replay
    // so the migration can consume them on the next boot. Indexes and triggers
    // stay absent during this load, avoiding per-row maintenance and preserving
    // aggregate values already stored in the backup.
    report("importing");
    const restoreStatements: [string, ...string[]] = [
      "DELETE FROM settings",
      "DELETE FROM schema_migrations",
      "DELETE FROM attendee_statuses",
      ...(migrations.hasPending ? legacyColumnRestores(statements) : []),
      ...statements,
    ];
    for (const batch of restoreBatches(restoreStatements)) {
      await executeBatch(noArgStatements(batch));
    }
    await rebuildIndexesAndTriggers();

    // Clear all module-level caches — the backup may carry different data for
    // every table, so any warm cache is now stale. clearAllCaches() covers the
    // same set as resetDatabase()'s finally block, including caches (holidays,
    // logistics-agents, sessions, settings) that a partial list would miss.
    report("clearing-caches");
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
export const restoreFromZip = async (
  zipData: Uint8Array,
  onProgress: RestoreProgressHandler = ignoreRestoreProgress,
): Promise<void> => {
  const backup = openBackup(zipData);
  inspectOpenBackup(backup);
  const { decoder, files } = backup;
  // Iterate in SCHEMA order for FK safety.
  const allSql = compact(
    SCHEMA_TABLE_NAMES.map((table) => files[`${table}.sql`]),
  ).map((content) => decoder.decode(content));

  // Every generated table file ends its statements with semicolons, so no
  // extra separator is needed between files.
  await restoreFromSql(allSql.join(""), onProgress);
};
