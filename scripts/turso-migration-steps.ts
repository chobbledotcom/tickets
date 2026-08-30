import { join } from "@std/path";
import {
  readSnapshotRequest,
  type SnapshotProgressWriter,
  type SnapshotRequest,
} from "#scripts/database-snapshot-lib.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { tursoDatabaseSlug } from "#shared/config.ts";
import { errorMessage } from "#shared/error-message.ts";
import { requireSuccess } from "#shared/result.ts";
import type { TursoApi, TursoDatabaseCredentials } from "#shared/turso-api.ts";

/** Everything a migration needs from the outside world, so tests can stand in. */
export interface TursoMigrationDeps extends ScriptIo {
  createApi: (apiToken: string, signal: AbortSignal) => TursoApi;
  createSnapshot: (
    request: SnapshotRequest,
    writeProgress: SnapshotProgressWriter,
    signal: AbortSignal,
  ) => Promise<string>;
  makeTempDir: () => Promise<string>;
  prompt: (message: string) => string | null;
  promptSecret: (message: string) => string | null;
  removeTempDir: (path: string) => Promise<void>;
  signal: AbortSignal;
  uploadDatabaseFile: (
    path: string,
    credentials: TursoDatabaseCredentials,
    signal: AbortSignal,
  ) => Promise<void>;
  verifyUploadFile: (path: string, signal: AbortSignal) => Promise<void>;
}

/** Where a migrated database will live. */
export interface TursoTarget {
  group: string;
  organization: string;
}

export interface MigrationOutcome {
  cleanupError: unknown | null;
  credentials: TursoDatabaseCredentials;
  tempDirectory: string;
}

/** Thrown when the person running the task presses Ctrl-D at a question. */
export class MigrationCancelled extends Error {}

/** Read an answer that must be there, or stop. */
export const requiredAnswer = (value: string | null, label: string): string => {
  if (value === null) throw new MigrationCancelled("Migration cancelled.");
  const answer = value.trim();
  if (!answer) throw new Error(`${label} is required.`);
  return answer;
};

/** Read a setting from the environment, treating blank as missing. */
export const configuredValue = (
  deps: Pick<TursoMigrationDeps, "getEnv">,
  key: string,
): string | null => {
  const value = deps.getEnv(key)?.trim();
  return value ? value : null;
};

/** Read a setting, asking for it when it is not already configured. */
export const configuredOrAsked = (
  deps: Pick<TursoMigrationDeps, "getEnv" | "promptSecret">,
  key: string,
  question: string,
): string =>
  configuredValue(deps, key) ??
  requiredAnswer(deps.promptSecret(question), question);

/** Pick a Turso organization or group, using the configured one when set. */
export const chooseTursoName = (
  deps: Pick<TursoMigrationDeps, "getEnv" | "prompt">,
  kind: "group" | "organization",
  configured: string | null,
  available: string[],
): string => {
  if (available.length === 0)
    throw new Error(`No Turso ${kind}s are available.`);
  if (configured !== null) {
    if (!available.includes(configured)) {
      throw new Error(
        `TURSO_${kind.toUpperCase()} is not available: ${configured}`,
      );
    }
    return configured;
  }
  const [onlyChoice] = available;
  if (available.length === 1 && onlyChoice !== undefined) return onlyChoice;
  const answer = requiredAnswer(
    deps.prompt(`Turso ${kind} (${available.join(", ")}):`),
    `Turso ${kind}`,
  );
  if (!available.includes(answer)) {
    throw new Error(`Turso ${kind} must be one of: ${available.join(", ")}.`);
  }
  return answer;
};

/** Find the organization and group new databases should be created in. */
const resolveTursoTarget = async (
  deps: TursoMigrationDeps,
  api: TursoApi,
): Promise<TursoTarget> => {
  const organization = chooseTursoName(
    deps,
    "organization",
    configuredValue(deps, "TURSO_ORGANIZATION"),
    requireSuccess(await api.listOrganizations()),
  );
  deps.signal.throwIfAborted();
  const group = chooseTursoName(
    deps,
    "group",
    configuredValue(deps, "TURSO_GROUP"),
    requireSuccess(await api.listGroups(organization)),
  );
  deps.signal.throwIfAborted();
  return { group, organization };
};

const deleteIncompleteDatabase = async (
  api: TursoApi,
  organization: string,
  credentials: TursoDatabaseCredentials,
  uploadError: unknown,
): Promise<never> => {
  try {
    requireSuccess(await api.deleteDatabase(organization, credentials.name));
  } catch (cleanupError) {
    throw new Error(
      `${errorMessage(uploadError)}. Cleanup also failed: ${errorMessage(
        cleanupError,
      )}`,
    );
  }
  throw uploadError;
};

/** Copy one database into a brand new Turso database, through a temporary file. */
const migrateSnapshot = async (
  deps: TursoMigrationDeps,
  api: TursoApi,
  source: Omit<SnapshotRequest, "outputPath">,
  target: TursoTarget,
  name: string,
): Promise<MigrationOutcome> => {
  const tempDirectory = await deps.makeTempDir();
  let credentials: TursoDatabaseCredentials;
  try {
    deps.signal.throwIfAborted();
    deps.stdout("Downloading the source database...");
    const path = await deps.createSnapshot(
      { ...source, outputPath: join(tempDirectory, "database.sqlite") },
      deps.stdout,
      deps.signal,
    );
    deps.signal.throwIfAborted();
    deps.stdout("Checking the SQLite file for Turso...");
    await deps.verifyUploadFile(path, deps.signal);
    deps.signal.throwIfAborted();
    deps.stdout("Creating the Turso database...");
    credentials = requireSuccess(
      await api.createDatabase({
        group: target.group,
        name,
        organization: target.organization,
        seed: "database_upload",
      }),
    );
    deps.stdout("Uploading the SQLite file...");
    try {
      deps.signal.throwIfAborted();
      await deps.uploadDatabaseFile(path, credentials, deps.signal);
      deps.signal.throwIfAborted();
    } catch (error) {
      return await deleteIncompleteDatabase(
        api,
        target.organization,
        credentials,
        error,
      );
    }
  } catch (error) {
    try {
      await deps.removeTempDir(tempDirectory);
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)}. Temporary files could not be removed: ${errorMessage(
          cleanupError,
        )}. Remove this directory: ${tempDirectory}`,
      );
    }
    throw error;
  }

  let cleanupError: unknown | null = null;
  try {
    await deps.removeTempDir(tempDirectory);
  } catch (error) {
    cleanupError = error;
  }
  return { cleanupError, credentials, tempDirectory };
};

/**
 * Find a Turso name nobody is using. A name that is taken is a conflict only
 * the person running this can settle, so they are asked for another one rather
 * than the migration guessing or stopping.
 */
const freeDatabaseName = async (
  deps: TursoMigrationDeps,
  api: TursoApi,
  organization: string,
  wanted: string,
): Promise<string> => {
  let name = wanted;
  while (requireSuccess(await api.databaseExists(organization, name))) {
    deps.stdout(`Turso database already exists: ${organization}/${name}`);
    name = tursoDatabaseSlug(
      requiredAnswer(
        deps.prompt("Choose another Turso database name:"),
        "Turso database name",
      ),
    );
    deps.signal.throwIfAborted();
  }
  return name;
};

/** Where a database is being copied from. */
export interface MigrationSource {
  dbToken: string;
  dbUrl: string;
}

/** Check a source address and token before anything else happens. */
export const checkedSource = (source: MigrationSource): MigrationSource => {
  const sourceEnv: Record<string, string> = {
    DB_TOKEN: source.dbToken,
    DB_URL: source.dbUrl,
  };
  const checked = readSnapshotRequest(
    { outputPath: "database.sqlite" },
    (key) => sourceEnv[key],
  );
  return { dbToken: checked.dbToken, dbUrl: checked.dbUrl };
};

/**
 * Check the source address, claim the Turso name, copy the database over, and
 * print the new credentials. This is the whole migration every task shares.
 */
export const migrateDatabase = async (
  deps: TursoMigrationDeps,
  api: TursoApi,
  source: MigrationSource,
  wanted: string,
): Promise<MigrationOutcome> => {
  const checked = checkedSource(source);
  deps.stdout("Checking the Turso account...");
  const target = await resolveTursoTarget(deps, api);
  const name = await freeDatabaseName(deps, api, target.organization, wanted);
  deps.stdout(`Destination database: ${target.organization}/${name}`);
  deps.stdout(`Turso group: ${target.group}`);
  const outcome = await migrateSnapshot(deps, api, checked, target, name);
  deps.stdout("Database migrated to Turso.");
  deps.stdout(`DB_URL=${outcome.credentials.dbUrl}`);
  deps.stdout(`DB_TOKEN=${outcome.credentials.dbToken}`);
  return outcome;
};

/**
 * Run one migration task: refuse arguments, then turn any failure into a
 * console message and an exit code.
 */
export const runMigrationTask = async (
  deps: TursoMigrationDeps,
  usage: string,
  run: () => Promise<number>,
): Promise<number> => {
  if (deps.args.length !== 0) {
    deps.stderr(usage);
    return 1;
  }
  try {
    return await run();
  } catch (error) {
    return reportMigrationFailure(deps, error);
  }
};

/** Report leftover temporary files, and say whether the task should fail. */
export const reportCleanupError = (
  deps: Pick<TursoMigrationDeps, "stderr">,
  outcome: MigrationOutcome,
): boolean => {
  if (outcome.cleanupError === null) return false;
  deps.stderr(
    `The database was migrated, but temporary files could not be removed: ${errorMessage(
      outcome.cleanupError,
    )}`,
  );
  deps.stderr(`Remove this directory: ${outcome.tempDirectory}`);
  return true;
};

/** Turn a failure into a console message and an exit code. */
export const reportMigrationFailure = (
  deps: Pick<TursoMigrationDeps, "signal" | "stderr">,
  error: unknown,
): number => {
  if (deps.signal.aborted) {
    const message = errorMessage(error);
    deps.stderr(
      message === "Migration interrupted"
        ? "Migration interrupted."
        : `Migration interrupted: ${message}`,
    );
    return 130;
  }
  deps.stderr(
    error instanceof MigrationCancelled
      ? error.message
      : `Migration failed: ${errorMessage(error)}`,
  );
  return 1;
};
