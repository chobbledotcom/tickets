import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { SnapshotRequest } from "#scripts/database-snapshot-lib.ts";
import {
  MIGRATE_TURSO_USAGE,
  type MigrateTursoCliDeps,
  runMigrateTursoCli,
} from "#scripts/turso-migration-lib.ts";
import { errorResult, okResult } from "#shared/result.ts";
import type {
  CreateTursoDatabaseRequest,
  TursoApi,
} from "#shared/turso-api.ts";
import { fakeTursoApi, TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";

interface CliOptions {
  api?: Partial<TursoApi>;
  deps?: Partial<MigrateTursoCliDeps>;
  env?: Record<string, string>;
  promptAnswers?: (string | null)[];
  secretAnswers?: (string | null)[];
}

interface CliState {
  apiTokens: string[];
  createRequests: CreateTursoDatabaseRequest[];
  deleted: string[];
  deps: MigrateTursoCliDeps;
  events: string[];
  promptMessages: string[];
  removed: string[];
  secretMessages: string[];
  snapshots: SnapshotRequest[];
  stderr: string[];
  stdout: string[];
  uploads: string[];
}

const cliState = (options: CliOptions = {}): CliState => {
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
  const state: Omit<CliState, "deps"> = {
    apiTokens: [],
    createRequests: [],
    deleted: [],
    events: [],
    promptMessages: [],
    removed: [],
    secretMessages: [],
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
    createSnapshot: (request, writeProgress) => {
      state.events.push("snapshot");
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

const uploadFailureState = (api: Partial<TursoApi> = {}): CliState =>
  cliState({
    api,
    deps: {
      uploadDatabaseFile: () => Promise.reject(new Error("upload stopped")),
    },
  });

describe("Turso migration CLI", () => {
  test("downloads, verifies, and uploads the database file", async () => {
    const state = cliState();

    expect(await runMigrateTursoCli(state.deps)).toBe(0);

    expect(state.apiTokens).toEqual(["platform-token"]);
    expect(state.secretMessages).toEqual([
      "Source database password or token (DB_TOKEN):",
    ]);
    expect(state.events).toEqual([
      "exists:personal/destination-database",
      "temp",
      "snapshot",
      "verify",
      "create",
      "upload",
    ]);
    expect(state.snapshots).toEqual([
      {
        dbToken: "source-token",
        dbUrl: "libsql://source.example.com",
        outputPath: "/tmp/turso-migration-test/database.sqlite",
      },
    ]);
    expect(state.createRequests).toEqual([
      {
        group: "default",
        name: "destination-database",
        organization: "personal",
        seed: "database_upload",
      },
    ]);
    expect(state.uploads).toEqual([
      "/tmp/turso-migration-test/database.sqlite",
    ]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
    expect(state.stdout).toContain(`DB_URL=${TEST_TURSO_CREDENTIALS.dbUrl}`);
    expect(state.stdout).toContain(
      `DB_TOKEN=${TEST_TURSO_CREDENTIALS.dbToken}`,
    );
    expect(state.stdout.join("\n")).not.toContain("source-token");
    expect(state.stdout.join("\n")).not.toContain("platform-token");
  });

  test("asks for the API key and infers one organization and group", async () => {
    const state = cliState({
      env: {
        TURSO_API_TOKEN: " ",
        TURSO_GROUP: "",
        TURSO_ORGANIZATION: "",
      },
      secretAnswers: ["source-token", "entered-api-key"],
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(0);
    expect(state.apiTokens).toEqual(["entered-api-key"]);
    expect(state.secretMessages).toEqual([
      "Source database password or token (DB_TOKEN):",
      "Destination Turso API key:",
    ]);
    expect(state.promptMessages).toHaveLength(2);
  });

  test("asks which organization and group to use when several exist", async () => {
    const state = cliState({
      api: {
        listGroups: () => Promise.resolve(okResult(["default", "europe"])),
        listOrganizations: () =>
          Promise.resolve(okResult(["personal", "team"])),
      },
      env: { TURSO_GROUP: "", TURSO_ORGANIZATION: "" },
      promptAnswers: [
        "libsql://source.example.com",
        "destination",
        "team",
        "europe",
      ],
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(0);
    expect(state.createRequests[0]).toEqual({
      group: "europe",
      name: "destination",
      organization: "team",
      seed: "database_upload",
    });
    expect(state.promptMessages.slice(2)).toEqual([
      "Turso organization (personal, team):",
      "Turso group (default, europe):",
    ]);
  });

  test("stops before downloading when the destination already exists", async () => {
    const state = cliState({
      api: {
        databaseExists: () => Promise.resolve(okResult(true)),
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Migration failed: Turso database already exists: personal/destination-database",
    ]);
    expect(state.events).toEqual(["exists:personal/destination-database"]);
    expect(state.snapshots).toEqual([]);
  });

  test("requires an interactive run without arguments", async () => {
    const state = cliState({ deps: { args: ["extra"] } });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([MIGRATE_TURSO_USAGE]);
    expect(state.promptMessages).toEqual([]);
  });

  test("reports cancellation and blank answers", async () => {
    for (const [answer, message] of [
      [null, "Migration cancelled."],
      [" ", "Migration failed: Source database URL is required."],
    ] as const) {
      const state = cliState({ promptAnswers: [answer] });
      expect(await runMigrateTursoCli(state.deps)).toBe(1);
      expect(state.stderr).toEqual([message]);
    }
  });

  test("validates the source URL before calling Turso", async () => {
    const state = cliState({
      promptAnswers: ["file:source.sqlite", "destination"],
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Migration failed: DB_URL must use TLS. Plain connections are allowed only for loopback.",
    ]);
    expect(state.apiTokens).toEqual([]);
  });

  test("rejects configured Turso names that are not available", async () => {
    const organization = cliState({
      env: { TURSO_ORGANIZATION: "missing" },
    });
    expect(await runMigrateTursoCli(organization.deps)).toBe(1);
    expect(organization.stderr[0]).toContain(
      "TURSO_ORGANIZATION is not available: missing",
    );

    const group = cliState({ env: { TURSO_GROUP: "missing" } });
    expect(await runMigrateTursoCli(group.deps)).toBe(1);
    expect(group.stderr[0]).toContain("TURSO_GROUP is not available: missing");
  });

  test("rejects missing and invalid Turso choices", async () => {
    const noOrganizations = cliState({
      api: { listOrganizations: () => Promise.resolve(okResult([])) },
      env: { TURSO_ORGANIZATION: "" },
    });
    expect(await runMigrateTursoCli(noOrganizations.deps)).toBe(1);
    expect(noOrganizations.stderr[0]).toContain(
      "No Turso organizations are available.",
    );

    const invalidOrganization = cliState({
      api: {
        listOrganizations: () => Promise.resolve(okResult(["one", "two"])),
      },
      env: { TURSO_ORGANIZATION: "" },
      promptAnswers: ["libsql://source.example.com", "destination", "three"],
    });
    expect(await runMigrateTursoCli(invalidOrganization.deps)).toBe(1);
    expect(invalidOrganization.stderr[0]).toContain(
      "Turso organization must be one of: one, two.",
    );

    const noGroups = cliState({
      api: { listGroups: () => Promise.resolve(okResult([])) },
      env: { TURSO_GROUP: "" },
    });
    expect(await runMigrateTursoCli(noGroups.deps)).toBe(1);
    expect(noGroups.stderr[0]).toContain("No Turso groups are available.");
  });

  test("removes temporary files when file verification fails", async () => {
    const state = cliState({
      deps: {
        verifyUploadFile: () => Promise.reject(new Error("wrong page size")),
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual(["Migration failed: wrong page size"]);
    expect(state.createRequests).toEqual([]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
  });

  test("removes temporary files when database creation fails", async () => {
    const state = cliState({
      api: {
        createDatabase: () =>
          Promise.resolve(errorResult("Create database failed (409): exists")),
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Migration failed: Create database failed (409): exists",
    ]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
  });

  test("deletes an incomplete database when upload fails", async () => {
    const state = uploadFailureState();

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual(["Migration failed: upload stopped"]);
    expect(state.deleted).toEqual(["personal/destination"]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
  });

  test("reports when incomplete database cleanup also fails", async () => {
    const state = uploadFailureState({
      deleteDatabase: () =>
        Promise.resolve(errorResult("Delete database failed (500): busy")),
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Migration failed: upload stopped. Cleanup also failed: Delete database failed (500): busy",
    ]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
  });
});
