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
import * as v from "valibot";
import {
  captureBackup,
  quoteSqlIdentifier,
  type TableBackup,
} from "#shared/db/backup-snapshot.ts";
import {
  backupKey,
  backupTimestamp,
  pruneOldBackups,
} from "#shared/db/backup-storage.ts";
import { OPEN_CHECKOUT_STAGE_SQL } from "#shared/db/checkout-stage-state.ts";
import {
  executeBatch,
  queryBatchPrimary,
  queryOnePrimary,
  resultRows,
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
import {
  dumpMigrationState,
  legacyColumnRestores,
} from "#shared/db/restore-legacy-columns.ts";
import { namedError } from "#shared/named-error.ts";
import { nowIso } from "#shared/now.ts";
import { uploadRaw } from "#shared/storage.ts";

/** Thrown by restoreFromSql after resetDatabase() runs but a later step fails,
 *  so callers can distinguish a post-reset failure (DB wiped) from a pre-reset
 *  validation error (DB intact). */
export class PostResetError extends namedError("PostResetError") {}

// ─── Types ──────────────────────────────────────────────────────

const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Metadata stored in manifest.json inside the backup zip. */
const BackupManifestSchema = v.object({
  checkoutStageRevision: v.optional(
    v.object({ revision: NonNegativeIntegerSchema }),
  ),
  latestUpdate: v.string(),
  schemaHash: v.string(),
  tables: v.record(
    v.pipe(v.string(), v.regex(/^\w+$/)),
    NonNegativeIntegerSchema,
  ),
  timestamp: v.string(),
});

export type BackupManifest = v.InferOutput<typeof BackupManifestSchema>;

// ─── Helpers ────────────────────────────────────────────────────

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

/** Build the manifest object for a backup */
const buildManifest = (
  tables: TableBackup[],
  timestamp: string,
  checkoutStageRevision?: { revision: number },
): BackupManifest => {
  const manifest: BackupManifest = {
    latestUpdate: LATEST_UPDATE,
    schemaHash: SCHEMA_HASH,
    tables: Object.fromEntries(
      tables.map(({ table, rowCount }) => [table, rowCount]),
    ),
    timestamp,
  };
  return checkoutStageRevision
    ? { ...manifest, checkoutStageRevision }
    : manifest;
};

/** Create a zip archive from table backups with manifest */
export const createBackupZip = async (): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const timestamp = nowIso();
  const capture = await captureBackup();
  const manifest = buildManifest(
    capture.tables,
    timestamp,
    capture.checkoutStageRevision,
  );

  const files: Record<string, Uint8Array> = {
    "manifest.json": encoder.encode(JSON.stringify(manifest, null, 2)),
  };
  for (const { table, sql } of capture.tables) {
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

/** Read and parse manifest.json from a backup zip. Returns null if missing or invalid. */
export const readManifest = (zipData: Uint8Array): BackupManifest | null => {
  const files = unzipSync(zipData);
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) return null;
  const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  const result = v.safeParse(BackupManifestSchema, parsed);
  return result.success ? result.output : null;
};

const validateArchiveFiles = (
  files: Record<string, Uint8Array>,
  manifest: BackupManifest | null,
): void => {
  const hasStages =
    files["checkout_stages.sql"] !== undefined ||
    manifest?.tables.checkout_stages !== undefined;
  if (hasStages && !manifest?.checkoutStageRevision) {
    throw new Error(
      "Backup contains checkout_stages but has no checkout stage revision certificate",
    );
  }
  if (!manifest) return;
  const manifestTables = new Set(Object.keys(manifest.tables));
  for (const table of manifestTables) {
    if (!files[`${table}.sql`]) {
      throw new Error(`Backup is missing table file ${table}.sql`);
    }
  }
  for (const filename of Object.keys(files).filter((name) =>
    name.endsWith(".sql"),
  )) {
    const table = filename.slice(0, -4);
    if (!manifestTables.has(table)) {
      throw new Error(
        `Backup table file ${filename} is absent from its manifest`,
      );
    }
  }
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
  const manifest = readManifest(zipData);
  validateArchiveFiles(files, manifest);
  const decoder = new TextDecoder();
  const allSql: string[] = [];

  // Iterate in SCHEMA order for FK safety
  for (const table of SCHEMA_TABLE_NAMES) {
    const content = files[`${table}.sql`];
    if (content) allSql.push(decoder.decode(content));
  }

  await restoreFromSql(allSql.join("\n"));

  let validationError: string | undefined;
  try {
    if (manifest) {
      // Older archives can name a table since removed or renamed. Preserve the
      // existing restore contract: migration history decides whether that age
      // is valid, while counts are checked for every table this build restores.
      const tables = Object.keys(manifest.tables).filter((table) =>
        SCHEMA_TABLE_NAMES.includes(table),
      );
      const results = await queryBatchPrimary(
        tables.map((table) => ({
          args: [],
          sql: `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`,
        })),
      );
      for (const [index, table] of tables.entries()) {
        const actual = Number(
          resultRows<{ count: number }>(results[index]!)[0]!.count,
        );
        const expected = manifest.tables[table]!;
        if (actual !== expected) {
          throw new Error(
            `Restored table ${table} has ${actual} rows; backup manifest records ${expected}`,
          );
        }
      }
    }

    const brokenStage = await queryOnePrimary<{
      attendee_id: number;
      payment_session_id: string;
      problem: string;
    }>(
      `SELECT stage.payment_session_id, stage.attendee_id,
              CASE WHEN attendee.id IS NULL THEN 'attendee'
                   ELSE 'booking' END AS problem
         FROM checkout_stages AS stage
         LEFT JOIN attendees AS attendee ON attendee.id = stage.attendee_id
        WHERE stage.state ${OPEN_CHECKOUT_STAGE_SQL}
          AND (attendee.id IS NULL OR NOT EXISTS (
            SELECT 1 FROM listing_attendees AS booking
             WHERE booking.attendee_id = stage.attendee_id
          ))
        LIMIT 1`,
      [],
    );
    if (brokenStage) {
      throw new Error(
        `Restored open checkout stage ${brokenStage.payment_session_id} has no ${brokenStage.problem} for attendee ${brokenStage.attendee_id}`,
      );
    }
  } catch (error) {
    validationError = String(error);
  }
  if (validationError !== undefined) {
    throw new PostResetError(validationError);
  }
};
