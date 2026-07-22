import { sum } from "#fp";
import type { ScriptIo } from "#scripts/script-runner.ts";
import {
  type BackupManifest,
  PostResetError,
  type RestoreProgress,
  type RestoreProgressHandler,
  type RestoreStage,
} from "#shared/db/backup.ts";
import { SCHEMA_HASH } from "#shared/db/migrations.ts";
import { errorMessage } from "#shared/error-message.ts";
import { formatBytes } from "#shared/limits.ts";

export const RESTORE_CONFIRMATION = "RESTORE";
export const RESTORE_USAGE = "Usage: deno task restore <backup.zip>";
const isFullCommitSha = (commit: string): boolean =>
  /^[0-9a-f]{40}$/.test(commit);

export interface RestoreCliDeps extends ScriptIo {
  inspectBackupZip: (data: Uint8Array) => {
    manifest: BackupManifest | null;
    statementCount: number;
  };
  prompt: (message: string) => string | null;
  readFile: (path: string) => Promise<Uint8Array>;
  readRecordedScriptCommit: () => Promise<string>;
  restoreFromZip: (
    data: Uint8Array,
    onProgress: RestoreProgressHandler,
  ) => Promise<void>;
}

const progressMessages: Record<
  RestoreStage,
  (progress: RestoreProgress) => string
> = {
  checking: ({ statementCount }) =>
    `Checking ${statementCount} SQL statements...`,
  "clearing-caches": () => "Clearing cached database data...",
  importing: ({ statementCount }) =>
    `Importing ${statementCount} SQL statements...`,
  rebuilding: () => "Recreating the database schema...",
  resetting: () => "Deleting current database data...",
};

const countLabel = (count: number, name: string): string =>
  `${count} ${name}${count === 1 ? "" : "s"}`;

const writeManifestSummary = (
  manifest: BackupManifest | null,
  statementCount: number,
  write: (line: string) => void,
): boolean => {
  if (manifest === null) {
    write("Backup manifest: not available");
    write(`Backup contents: ${countLabel(statementCount, "SQL statement")}`);
    return false;
  }

  const tableCount = Object.keys(manifest.tables).length;
  const rowCount = sum(Object.values(manifest.tables));
  write(`Backup created: ${manifest.timestamp}`);
  write(
    `Backup contents: ${countLabel(tableCount, "table")}, ` +
      `${countLabel(rowCount, "row")}, ` +
      countLabel(statementCount, "SQL statement"),
  );
  const schemaMismatch = manifest.schemaHash !== SCHEMA_HASH;
  write(
    schemaMismatch
      ? "Schema: does not match this version of the app"
      : "Schema: matches this version of the app",
  );
  return schemaMismatch;
};

export const runRestoreCli = async (deps: RestoreCliDeps): Promise<number> => {
  if (deps.args.length !== 1 || !deps.args[0]?.trim()) {
    deps.stderr(RESTORE_USAGE);
    return 1;
  }

  const path = deps.args[0];
  const dbUrl = deps.getEnv("DB_URL");
  if (!dbUrl?.trim()) {
    deps.stderr("DB_URL is required in .env.");
    return 1;
  }
  if (dbUrl === ":memory:") {
    deps.stderr(
      "DB_URL cannot be :memory: for a restore. Set it to the target database in .env.",
    );
    return 1;
  }
  if (dbUrl.startsWith("libsql://") && !deps.getEnv("DB_TOKEN")?.trim()) {
    deps.stderr("DB_TOKEN is required in .env for a remote database.");
    return 1;
  }

  deps.stdout(`Reading ${path}...`);
  let data: Uint8Array;
  try {
    data = await deps.readFile(path);
  } catch (error) {
    deps.stderr(`Could not read ${path}: ${errorMessage(error)}`);
    return 1;
  }

  let inspection: ReturnType<RestoreCliDeps["inspectBackupZip"]>;
  try {
    inspection = deps.inspectBackupZip(data);
  } catch (error) {
    deps.stderr(`${path} is not a valid database backup.`);
    deps.stderr(errorMessage(error));
    return 1;
  }

  deps.stdout(`Backup file: ${path} (${formatBytes(data.byteLength)})`);
  deps.stdout(`Target database: ${dbUrl}`);
  const schemaMismatch = writeManifestSummary(
    inspection.manifest,
    inspection.statementCount,
    deps.stdout,
  );
  if (schemaMismatch) {
    deps.stderr(
      "Warning: This backup uses a different database schema. The app may need to apply database updates after the restore.",
    );
  }
  deps.stdout(
    "Warning: This will delete all current data in the target database. This cannot be undone.",
  );

  if (
    deps.prompt(`Type ${RESTORE_CONFIRMATION} to continue:`) !==
    RESTORE_CONFIRMATION
  ) {
    deps.stderr("Restore cancelled. The database was not changed.");
    return 1;
  }

  try {
    await deps.restoreFromZip(data, (progress) =>
      deps.stdout(progressMessages[progress.stage](progress)),
    );
  } catch (error) {
    deps.stderr(`Restore failed: ${errorMessage(error)}`);
    if (error instanceof PostResetError) {
      deps.stderr(
        "The target database was reset before the restore failed. Fix the error and run the restore again.",
      );
    }
    return 1;
  }

  deps.stdout("Database restored successfully.");
  let commit: string;
  try {
    commit = await deps.readRecordedScriptCommit();
  } catch (error) {
    deps.stderr(
      "The database was restored, but its build information could not be read: " +
        errorMessage(error),
    );
    return 1;
  }
  if (isFullCommitSha(commit)) {
    deps.stdout(`The backup was running commit ${commit}.`);
    deps.stdout(
      "Run the restore-deploy workflow with this commit if the app code must also be restored to that point in time.",
    );
  }
  return 0;
};
