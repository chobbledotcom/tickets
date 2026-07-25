import type { SnapshotRequest } from "#scripts/database-snapshot-lib.ts";
import type { MigrateTursoCliDeps } from "#scripts/turso-migration-lib.ts";
import type {
  CreateTursoDatabaseRequest,
  TursoApi,
} from "#shared/turso-api.ts";
import { fakeTursoApi } from "#test-utils/turso-api.ts";

export interface TursoMigrationCliOptions {
  api?: Partial<TursoApi>;
  deps?: Partial<MigrateTursoCliDeps>;
  env?: Record<string, string>;
  promptAnswers?: (string | null)[];
  secretAnswers?: (string | null)[];
}

export interface TursoMigrationCliState {
  apiTokens: string[];
  createRequests: CreateTursoDatabaseRequest[];
  deleted: string[];
  deps: MigrateTursoCliDeps;
  events: string[];
  promptMessages: string[];
  removed: string[];
  secretMessages: string[];
  snapshotSignals: AbortSignal[];
  snapshots: SnapshotRequest[];
  stderr: string[];
  stdout: string[];
  uploads: string[];
}

export const tursoMigrationCliState = (
  options: TursoMigrationCliOptions = {},
): TursoMigrationCliState => {
  const env: Record<string, string> = {
    TURSO_API_TOKEN: "platform-token",
    TURSO_GROUP: "default",
    TURSO_ORGANIZATION: "personal",
    ...options.env,
  };
  const promptAnswers = options.promptAnswers ?? [
    "libsql://source.example.com",
    "Destination Database",
  ];
  const secretAnswers = options.secretAnswers ?? ["source-token"];
  const state: Omit<TursoMigrationCliState, "deps"> = {
    apiTokens: [],
    createRequests: [],
    deleted: [],
    events: [],
    promptMessages: [],
    removed: [],
    secretMessages: [],
    snapshotSignals: [],
    snapshots: [],
    stderr: [],
    stdout: [],
    uploads: [],
  };
  const apiBehavior = fakeTursoApi(options.api);
  const api: TursoApi = {
    ...apiBehavior,
    createDatabase: (request) => {
      state.events.push("create");
      state.createRequests.push(request);
      return apiBehavior.createDatabase(request);
    },
    databaseExists: (organization, name) => {
      state.events.push(`exists:${organization}/${name}`);
      return apiBehavior.databaseExists(organization, name);
    },
    deleteDatabase: (organization, name) => {
      state.deleted.push(`${organization}/${name}`);
      return apiBehavior.deleteDatabase(organization, name);
    },
  };
  const deps: MigrateTursoCliDeps = {
    args: [],
    createApi: (token) => {
      state.apiTokens.push(token);
      return api;
    },
    createSnapshot: (request, writeProgress, signal) => {
      state.events.push("snapshot");
      state.snapshotSignals.push(signal);
      state.snapshots.push(request);
      writeProgress("[1/4] Checking destination");
      return Promise.resolve(request.outputPath);
    },
    getEnv: (key) => env[key],
    makeTempDir: () => {
      state.events.push("temp");
      return Promise.resolve("/tmp/turso-migration-test");
    },
    prompt: (message) => {
      state.promptMessages.push(message);
      return promptAnswers.shift() ?? null;
    },
    promptSecret: (message) => {
      state.secretMessages.push(message);
      return secretAnswers.shift() ?? null;
    },
    removeTempDir: (path) => {
      state.removed.push(path);
      return Promise.resolve();
    },
    signal: new AbortController().signal,
    stderr: (line) => state.stderr.push(line),
    stdout: (line) => state.stdout.push(line),
    uploadDatabaseFile: (path) => {
      state.events.push("upload");
      state.uploads.push(path);
      return Promise.resolve();
    },
    verifyUploadFile: () => {
      state.events.push("verify");
      return Promise.resolve();
    },
    ...options.deps,
  };
  return { ...state, deps };
};

export const failedTursoUploadState = (
  api: Partial<TursoApi> = {},
): TursoMigrationCliState =>
  tursoMigrationCliState({
    api,
    deps: {
      uploadDatabaseFile: () => Promise.reject(new Error("upload stopped")),
    },
  });
