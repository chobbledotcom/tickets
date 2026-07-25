import { join } from "@std/path";
import { withCleanup } from "#scripts/cleanup.ts";
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
  createApi: (apiToken: string) => TursoApi;
  createSnapshot: (
    request: SnapshotRequest,
    writeProgress: SnapshotProgressWriter,
  ) => Promise<string>;
  makeTempDir: () => Promise<string>;
  prompt: (message: string) => string | null;
  promptSecret: (message: string) => string | null;
  removeTempDir: (path: string) => Promise<void>;
  uploadDatabaseFile: (
    path: string,
    api: TursoApi,
    credentials: TursoDatabaseCredentials,
  ) => Promise<void>;
  verifyUploadFile: (path: string) => Promise<void>;
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
): Promise<TursoDatabaseCredentials> => {
  const tempDirectory = await deps.makeTempDir();
  return await withCleanup(async () => {
    deps.stdout("Downloading the source database...");
    const path = await deps.createSnapshot(
      { ...source, outputPath: join(tempDirectory, "database.sqlite") },
      deps.stdout,
    );
    deps.stdout("Checking the SQLite file for Turso...");
    await deps.verifyUploadFile(path);
    deps.stdout("Creating the Turso database...");
    const credentials = requireSuccess(
      await api.createDatabase({
        group,
        name,
        organization,
        seed: "database_upload",
      }),
    );
    deps.stdout("Uploading the SQLite file...");
    try {
      await deps.uploadDatabaseFile(path, api, credentials);
    } catch (error) {
      return await deleteIncompleteDatabase(
        api,
        organization,
        credentials,
        error,
      );
    }
    return credentials;
  }, [() => deps.removeTempDir(tempDirectory)]);
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
    const source = readSnapshotRequest(
      { outputPath: "database.sqlite" },
      (key) => (key === "DB_URL" ? dbUrl : dbToken),
    );
    const api = deps.createApi(apiToken);
    deps.stdout("Checking the Turso account...");
    const organization = chooseTursoName(
      deps,
      "organization",
      configuredValue(deps, "TURSO_ORGANIZATION"),
      requireSuccess(await api.listOrganizations()),
    );
    const group = chooseTursoName(
      deps,
      "group",
      configuredValue(deps, "TURSO_GROUP"),
      requireSuccess(await api.listGroups(organization)),
    );
    if (requireSuccess(await api.databaseExists(organization, name))) {
      throw new Error(`Turso database already exists: ${organization}/${name}`);
    }

    deps.stdout(`Destination database: ${organization}/${name}`);
    deps.stdout(`Turso group: ${group}`);
    const credentials = await migrateSnapshot(
      deps,
      api,
      { dbToken: source.dbToken, dbUrl: source.dbUrl },
      organization,
      group,
      name,
    );
    deps.stdout("Database migrated to Turso.");
    deps.stdout(`DB_URL=${credentials.dbUrl}`);
    deps.stdout(`DB_TOKEN=${credentials.dbToken}`);
    deps.stdout(
      "Keep using the source DB_ENCRYPTION_KEY. It is not stored in the database file.",
    );
    return 0;
  } catch (error) {
    deps.stderr(
      error instanceof MigrationCancelled
        ? error.message
        : `Migration failed: ${errorMessage(error)}`,
    );
    return 1;
  }
};
