import { join } from "@std/path";
import {
  readSnapshotRequest,
  type SnapshotProgressWriter,
  type SnapshotRequest,
} from "#scripts/database-snapshot-lib.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { errorMessage } from "#shared/error-message.ts";
import { requireSuccess } from "#shared/result.ts";
import {
  slugifyForTurso,
  type TursoApi,
  type TursoDatabaseCredentials,
} from "#shared/turso-api.ts";

export const MIGRATE_TURSO_USAGE = "Usage: deno task migrate:turso";

export interface MigrateTursoCliDeps extends ScriptIo {
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

interface MigrationOutcome {
  cleanupError: unknown | null;
  credentials: TursoDatabaseCredentials;
  tempDirectory: string;
}

class MigrationCancelled extends Error {}

const requiredAnswer = (value: string | null, label: string): string => {
  if (value === null) throw new MigrationCancelled("Migration cancelled.");
  const answer = value.trim();
  if (!answer) throw new Error(`${label} is required.`);
  return answer;
};

const configuredValue = (
  deps: MigrateTursoCliDeps,
  key: string,
): string | null => {
  const value = deps.getEnv(key)?.trim();
  return value ? value : null;
};

const chooseTursoName = (
  deps: MigrateTursoCliDeps,
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

const migrateSnapshot = async (
  deps: MigrateTursoCliDeps,
  api: TursoApi,
  source: Omit<SnapshotRequest, "outputPath">,
  organization: string,
  group: string,
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
        group,
        name,
        organization,
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
        organization,
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

/** Run the interactive source-to-Turso database migration. */
export const runMigrateTursoCli = async (
  deps: MigrateTursoCliDeps,
): Promise<number> => {
  if (deps.args.length !== 0) {
    deps.stderr(MIGRATE_TURSO_USAGE);
    return 1;
  }

  try {
    const dbUrl = requiredAnswer(
      deps.prompt("Source database URL:"),
      "Source database URL",
    );
    const dbToken = requiredAnswer(
      deps.promptSecret("Source database password or token (DB_TOKEN):"),
      "Source database password or token",
    );
    const requestedName = requiredAnswer(
      deps.prompt("Destination Turso database name:"),
      "Destination Turso database name",
    );
    const name = slugifyForTurso(requestedName);
    const apiToken =
      configuredValue(deps, "TURSO_API_TOKEN") ??
      requiredAnswer(
        deps.promptSecret("Destination Turso API key:"),
        "Destination Turso API key",
      );
    const sourceEnv: Record<string, string> = {
      DB_TOKEN: dbToken,
      DB_URL: dbUrl,
    };
    const source = readSnapshotRequest(
      { outputPath: "database.sqlite" },
      (key) => sourceEnv[key],
    );
    const api = deps.createApi(apiToken, deps.signal);
    deps.stdout("Checking the Turso account...");
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
    if (requireSuccess(await api.databaseExists(organization, name))) {
      throw new Error(`Turso database already exists: ${organization}/${name}`);
    }

    deps.stdout(`Destination database: ${organization}/${name}`);
    deps.stdout(`Turso group: ${group}`);
    const outcome = await migrateSnapshot(
      deps,
      api,
      { dbToken: source.dbToken, dbUrl: source.dbUrl },
      organization,
      group,
      name,
    );
    deps.stdout("Database migrated to Turso.");
    deps.stdout(`DB_URL=${outcome.credentials.dbUrl}`);
    deps.stdout(`DB_TOKEN=${outcome.credentials.dbToken}`);
    deps.stdout(
      "Keep using the source DB_ENCRYPTION_KEY. It is not stored in the database file.",
    );
    if (outcome.cleanupError !== null) {
      deps.stderr(
        `The database was migrated, but temporary files could not be removed: ${errorMessage(
          outcome.cleanupError,
        )}`,
      );
      deps.stderr(`Remove this directory: ${outcome.tempDirectory}`);
      return 1;
    }
    return 0;
  } catch (error) {
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
  }
};
