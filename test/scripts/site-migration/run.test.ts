import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MIGRATE_SITES_USAGE,
  runSiteMigrationTui,
} from "#scripts/site-migration/run.ts";
import { okResult } from "#shared/result.ts";
import {
  bunnySite,
  siteMigrationCliState,
} from "#test-utils/site-migration.ts";
import { TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";

const tursoSite = {
  dbToken: "already-token",
  dbUrl: "libsql://done-org.turso.io",
  host: "turso" as const,
  name: "done-site",
  scriptId: "7",
};

describe("site migration TUI", () => {
  test("migrates the chosen site and repoints its secrets", async () => {
    const state = siteMigrationCliState();

    expect(await runSiteMigrationTui(state.deps)).toBe(0);

    expect(state.events).toEqual([
      "exists:personal/first-site",
      "temp",
      "snapshot",
      "verify",
      "create",
      "upload",
    ]);
    expect(state.snapshots).toEqual([
      {
        dbToken: "first-site-token",
        dbUrl: "libsql://abc-first-site.lite.bunnydb.net",
        outputPath: "/tmp/turso-migration-test/database.sqlite",
      },
    ]);
    expect(state.secretUpdates).toEqual([
      {
        bunnyApiKey: "bunny-key",
        scriptId: "42",
        secrets: [
          ["DB_URL", TEST_TURSO_CREDENTIALS.dbUrl],
          ["DB_TOKEN", TEST_TURSO_CREDENTIALS.dbToken],
        ],
      },
    ]);
    expect(state.stdout).toContain("first-site now uses its Turso database.");
    expect(state.stdout.join("\n")).toContain(
      'open the built site "first-site" on the main site and save the new DB_URL and DB_TOKEN',
    );
  });

  test("lists each site with the company running its database", async () => {
    const state = siteMigrationCliState({
      promptAnswers: ["q"],
      sites: [bunnySite("first-site", "42"), tursoSite],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(0);

    expect(state.stdout).toContain(
      "  1. first-site — bunny database (script 42)",
    );
    expect(state.stdout).toContain(
      "  2. done-site — turso database (script 7)",
    );
    expect(state.secretUpdates).toEqual([]);
  });

  test("refuses a site that is already off Bunny, then carries on", async () => {
    const state = siteMigrationCliState({
      promptAnswers: ["1", "q"],
      sites: [tursoSite],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.stderr).toContain(
      "Migration failed: done-site is not on a Bunny database (it is on: turso).",
    );
    expect(state.events).toEqual([]);
    expect(state.secretUpdates).toEqual([]);
  });

  test("warns that bookings made during the copy are lost", async () => {
    const state = siteMigrationCliState({ promptAnswers: ["1", "wrong", "q"] });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.stdout.join("\n")).toContain(
      "Any booking made during the copy stays in the old database and is lost.",
    );
  });

  test("stops the migration when the typed name does not match", async () => {
    const state = siteMigrationCliState({
      promptAnswers: ["1", "wrong-name", "q"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.stderr).toContain(
      "Migration failed: Site name does not match. Please type the exact name to confirm.",
    );
    expect(state.events).toEqual([]);
    expect(state.secretUpdates).toEqual([]);
  });

  test("does not update the secrets when the migration fails", async () => {
    const state = siteMigrationCliState({
      deps: {
        uploadDatabaseFile: () => Promise.reject(new Error("upload stopped")),
      },
      promptAnswers: ["1", "first-site", "q"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.secretUpdates).toEqual([]);
    expect(state.deleted).toEqual(["personal/destination-database"]);
    expect(state.stderr).toContain("Migration failed: upload stopped");
  });

  test("puts the old database back when repointing fails", async () => {
    const attempts: string[][] = [];
    const state = siteMigrationCliState({
      promptAnswers: ["1", "first-site", "q"],
      siteDeps: {
        setSiteSecrets: (_key, _scriptId, secrets) => {
          attempts.push(secrets.map(([, value]) => value));
          return attempts.length === 1
            ? Promise.reject(new Error("Bunny refused"))
            : Promise.resolve();
        },
      },
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(attempts).toEqual([
      [TEST_TURSO_CREDENTIALS.dbUrl, TEST_TURSO_CREDENTIALS.dbToken],
      ["libsql://abc-first-site.lite.bunnydb.net", "first-site-token"],
    ]);
    expect(state.stderr).toContain(
      "Migration failed: Bunny refused. first-site was put back on its old database.",
    );
    expect(state.stdout).toContain(`DB_URL=${TEST_TURSO_CREDENTIALS.dbUrl}`);
  });

  test("says to set the secrets by hand when the undo also fails", async () => {
    const state = siteMigrationCliState({
      promptAnswers: ["1", "first-site", "q"],
      siteDeps: {
        setSiteSecrets: () => Promise.reject(new Error("Bunny refused")),
      },
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.stderr).toContain(
      "Migration failed: Bunny refused. first-site could not be put back on its old database either: Bunny refused. Set DB_URL and DB_TOKEN by hand.",
    );
  });

  test("does not repoint the site when the run is interrupted after the upload", async () => {
    const interruption = new AbortController();
    const state = siteMigrationCliState({
      deps: {
        signal: interruption.signal,
        uploadDatabaseFile: () => {
          interruption.abort(new Error("Migration interrupted"));
          return Promise.resolve();
        },
      },
      promptAnswers: ["1", "first-site"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(130);

    expect(state.secretUpdates).toEqual([]);
  });

  test("repoints the site but fails when temporary files are left behind", async () => {
    const state = siteMigrationCliState({
      deps: {
        removeTempDir: () => Promise.reject(new Error("directory in use")),
      },
      promptAnswers: ["1", "first-site", "q"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.secretUpdates.length).toBe(1);
    expect(state.stderr).toContain(
      "The database was migrated, but temporary files could not be removed: directory in use",
    );
    expect(state.stderr).toContain(
      "Remove this directory: /tmp/turso-migration-test",
    );
  });

  test("asks for another name when the site name is already taken", async () => {
    const taken = new Set(["first-site"]);
    const state = siteMigrationCliState({
      api: {
        databaseExists: (_organization, name) =>
          Promise.resolve(okResult(taken.has(name))),
      },
      promptAnswers: ["1", "first-site", "First Site Two", "q"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(0);

    expect(state.stdout).toContain(
      "Turso database already exists: personal/first-site",
    );
    expect(state.createRequests[0]?.name).toBe("first-site-two");
  });

  test("keeps going after one site fails", async () => {
    const state = siteMigrationCliState({
      promptAnswers: ["9", "1", "first-site", "q"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(0);

    expect(state.stderr).toContain(
      "Migration failed: Choose a number between 1 and 1.",
    );
    expect(state.secretUpdates.length).toBe(1);
  });

  test("stops when the person cancels a question", async () => {
    const state = siteMigrationCliState({ promptAnswers: [] });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.stderr).toContain("Migration cancelled.");
  });

  test("fails when the main site lists no sites", async () => {
    const state = siteMigrationCliState({ sites: [] });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.stderr).toContain(
      "Migration failed: The main site listed no sites.",
    );
  });

  test("asks for the settings that are not configured", async () => {
    const state = siteMigrationCliState({
      env: {
        BUNNY_API_KEY: "",
        MAIN_INSTANCE_KEY: "",
        MAIN_INSTANCE_URL: "",
        TURSO_API_TOKEN: "",
      },
      promptAnswers: ["https://typed.example.com", "q"],
      secretAnswers: ["typed-main-key", "typed-bunny-key", "typed-turso-key"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(0);

    expect(state.secretMessages).toEqual([
      "Main site key:",
      "Bunny key:",
      "Turso API key:",
    ]);
    expect(state.apiTokens).toEqual(["typed-turso-key"]);
  });

  test("requires an interactive run without arguments", async () => {
    const state = siteMigrationCliState({ deps: { args: ["one"] } });

    expect(await runSiteMigrationTui(state.deps)).toBe(1);

    expect(state.stderr).toEqual([MIGRATE_SITES_USAGE]);
  });

  test("reports an interruption", async () => {
    const interruption = new AbortController();
    const state = siteMigrationCliState({
      deps: {
        createSnapshot: () => {
          interruption.abort(new Error("Migration interrupted"));
          return Promise.reject(new Error("Migration interrupted"));
        },
        signal: interruption.signal,
      },
      promptAnswers: ["1", "first-site"],
    });

    expect(await runSiteMigrationTui(state.deps)).toBe(130);

    expect(state.stderr).toContain("Migration interrupted.");
    expect(state.secretUpdates).toEqual([]);
  });
});
