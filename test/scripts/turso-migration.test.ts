import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MIGRATE_TURSO_USAGE,
  runMigrateTursoCli,
} from "#scripts/turso-migration-lib.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { has, says } from "#test-utils/says.ts";
import { TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";
import {
  failedTursoUploadState,
  tursoMigrationCliState,
} from "#test-utils/turso-migration.ts";

describe("Turso migration CLI", () => {
  test("downloads, verifies, and uploads the database file", async () => {
    const state = tursoMigrationCliState();

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
    expect(state.snapshotSignals).toEqual([state.deps.signal]);
    expect(state.verifySignals).toEqual([state.deps.signal]);
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
    has(state.stdout, `DB_URL=${TEST_TURSO_CREDENTIALS.dbUrl}`);
    has(state.stdout, `DB_TOKEN=${TEST_TURSO_CREDENTIALS.dbToken}`);
    assert(!state.stdout.join("\n").includes("source-token"));
    assert(!state.stdout.join("\n").includes("platform-token"));
  });

  test("asks for the API key and infers one organization and group", async () => {
    const state = tursoMigrationCliState({
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
    const state = tursoMigrationCliState({
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

  test("asks for another name when the destination already exists", async () => {
    const taken = new Set(["destination-database"]);
    const state = tursoMigrationCliState({
      api: {
        databaseExists: (_organization, name) =>
          Promise.resolve(okResult(taken.has(name))),
      },
      promptAnswers: [
        "libsql://source.example.com",
        "Destination Database",
        "Second Choice",
      ],
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(0);
    has(
      state.stdout,
      "Turso database already exists: personal/destination-database",
    );
    has(state.promptMessages, "Choose another Turso database name:");
    expect(state.createRequests).toEqual([
      {
        group: "default",
        name: "second-choice",
        organization: "personal",
        seed: "database_upload",
      },
    ]);
  });

  test("stops when no other Turso name is given", async () => {
    const state = tursoMigrationCliState({
      api: {
        databaseExists: () => Promise.resolve(okResult(true)),
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual(["Migration cancelled."]);
    expect(state.snapshots).toEqual([]);
  });

  test("requires an interactive run without arguments", async () => {
    const state = tursoMigrationCliState({ deps: { args: ["extra"] } });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([MIGRATE_TURSO_USAGE]);
    expect(state.promptMessages).toEqual([]);
  });

  test("reports cancellation at the source URL prompt", async () => {
    const state = tursoMigrationCliState({ promptAnswers: [null] });
    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual(["Migration cancelled."]);
  });

  test("rejects a blank source URL", async () => {
    const state = tursoMigrationCliState({ promptAnswers: [" "] });
    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Migration failed: Source database URL is required.",
    ]);
  });

  test("reports cancellation at a hidden prompt", async () => {
    const state = tursoMigrationCliState({ secretAnswers: [] });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual(["Migration cancelled."]);
    expect(state.secretMessages).toEqual([
      "Source database password or token (DB_TOKEN):",
    ]);
  });

  test("validates the source URL before calling Turso", async () => {
    const state = tursoMigrationCliState({
      promptAnswers: ["file:source.sqlite", "destination"],
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Migration failed: DB_URL must use TLS. Plain connections are allowed only for loopback.",
    ]);
    expect(state.apiTokens).toEqual([]);
  });

  test("rejects configured Turso names that are not available", async () => {
    const organization = tursoMigrationCliState({
      env: { TURSO_ORGANIZATION: "missing" },
    });
    expect(await runMigrateTursoCli(organization.deps)).toBe(1);
    says(
      organization.stderr[0],
      "TURSO_ORGANIZATION is not available: missing",
    );

    const group = tursoMigrationCliState({
      env: { TURSO_GROUP: "missing" },
    });
    expect(await runMigrateTursoCli(group.deps)).toBe(1);
    says(group.stderr[0], "TURSO_GROUP is not available: missing");
  });

  test("rejects missing and invalid Turso choices", async () => {
    const noOrganizations = tursoMigrationCliState({
      api: { listOrganizations: () => Promise.resolve(okResult([])) },
      env: { TURSO_ORGANIZATION: "" },
    });
    expect(await runMigrateTursoCli(noOrganizations.deps)).toBe(1);
    says(noOrganizations.stderr[0], "No Turso organizations are available.");

    const invalidOrganization = tursoMigrationCliState({
      api: {
        listOrganizations: () => Promise.resolve(okResult(["one", "two"])),
      },
      env: { TURSO_ORGANIZATION: "" },
      promptAnswers: ["libsql://source.example.com", "destination", "three"],
    });
    expect(await runMigrateTursoCli(invalidOrganization.deps)).toBe(1);
    says(
      invalidOrganization.stderr[0],
      "Turso organization must be one of: one, two.",
    );

    const noGroups = tursoMigrationCliState({
      api: { listGroups: () => Promise.resolve(okResult([])) },
      env: { TURSO_GROUP: "" },
    });
    expect(await runMigrateTursoCli(noGroups.deps)).toBe(1);
    says(noGroups.stderr[0], "No Turso groups are available.");
  });

  test("removes temporary files when file verification fails", async () => {
    const state = tursoMigrationCliState({
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
    const state = tursoMigrationCliState({
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
    const state = failedTursoUploadState();

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual(["Migration failed: upload stopped"]);
    expect(state.deleted).toEqual(["personal/destination-database"]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
  });

  test("reports when incomplete database cleanup also fails", async () => {
    const state = failedTursoUploadState({
      deleteDatabase: () =>
        Promise.resolve(errorResult("Delete database failed (500): busy")),
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Migration failed: upload stopped. Cleanup also failed: Delete database failed (500): busy",
    ]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
  });

  test("prints credentials when local cleanup fails after migration", async () => {
    const state = tursoMigrationCliState({
      deps: {
        removeTempDir: () => Promise.reject(new Error("permission denied")),
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    has(state.stdout, `DB_URL=${TEST_TURSO_CREDENTIALS.dbUrl}`);
    has(state.stdout, `DB_TOKEN=${TEST_TURSO_CREDENTIALS.dbToken}`);
    expect(state.stderr).toEqual([
      "The database was migrated, but temporary files could not be removed: permission denied",
      "Remove this directory: /tmp/turso-migration-test",
    ]);
    expect(state.deleted).toEqual([]);
  });

  test("cleans up remote and local state after an interrupted upload", async () => {
    const controller = new AbortController();
    const state = tursoMigrationCliState({
      deps: {
        signal: controller.signal,
        uploadDatabaseFile: () => {
          controller.abort(new Error("Migration interrupted"));
          return Promise.reject(controller.signal.reason);
        },
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(130);
    expect(state.stderr).toEqual(["Migration interrupted."]);
    expect(state.deleted).toEqual(["personal/destination-database"]);
    expect(state.removed).toEqual(["/tmp/turso-migration-test"]);
  });

  test("reports cleanup failures during an interruption", async () => {
    const controller = new AbortController();
    const state = tursoMigrationCliState({
      deps: {
        removeTempDir: () => Promise.reject(new Error("permission denied")),
        signal: controller.signal,
        uploadDatabaseFile: () => {
          controller.abort(new Error("interrupted"));
          return Promise.reject(controller.signal.reason);
        },
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(130);
    says(state.stderr[0], "interrupted");
    says(state.stderr[0], "permission denied");
    says(state.stderr[0], "/tmp/turso-migration-test");
  });

  test("reports the original failure and temp directory when cleanup fails", async () => {
    const state = tursoMigrationCliState({
      deps: {
        removeTempDir: () => Promise.reject(new Error("permission denied")),
        verifyUploadFile: () => Promise.reject(new Error("bad sqlite")),
      },
    });

    expect(await runMigrateTursoCli(state.deps)).toBe(1);
    says(state.stderr[0], "bad sqlite");
    says(state.stderr[0], "permission denied");
    says(state.stderr[0], "/tmp/turso-migration-test");
  });
});
