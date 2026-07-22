import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { zipSync } from "fflate";
import {
  RESTORE_CONFIRMATION,
  RESTORE_USAGE,
  type RestoreCliDeps,
  runRestoreCli,
} from "#scripts/restore-lib.ts";
import { inspectBackupZip, PostResetError } from "#shared/db/backup.ts";
import { SCHEMA_HASH } from "#shared/db/migrations.ts";

const encoder = new TextEncoder();
const FULL_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const backupZip = (
  manifest: Record<string, unknown> | null = {
    latestUpdate: "Current database layout",
    schemaHash: SCHEMA_HASH,
    tables: { settings: 2 },
    timestamp: "2026-07-22T12:00:00.000Z",
  },
): Uint8Array =>
  zipSync({
    ...(manifest === null
      ? {}
      : { "manifest.json": encoder.encode(JSON.stringify(manifest)) }),
    "settings.sql": encoder.encode(
      "INSERT INTO settings (key, value) VALUES ('one', '1');\n" +
        "INSERT INTO settings (key, value) VALUES ('two', '2');\n",
    ),
  });

interface CliState {
  deps: RestoreCliDeps;
  promptMessages: string[];
  readPaths: string[];
  restored: Uint8Array[];
  stderr: string[];
  stdout: string[];
}

const cliState = (overrides: Partial<RestoreCliDeps> = {}): CliState => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const promptMessages: string[] = [];
  const readPaths: string[] = [];
  const restored: Uint8Array[] = [];
  const zip = backupZip();
  return {
    deps: {
      args: ["backup.zip"],
      getEnv: (key) => (key === "DB_URL" ? "file:target.db" : undefined),
      inspectBackupZip,
      prompt: (message) => {
        promptMessages.push(message);
        return RESTORE_CONFIRMATION;
      },
      readFile: (path) => {
        readPaths.push(path);
        return Promise.resolve(zip);
      },
      readRecordedScriptCommit: () => Promise.resolve(""),
      restoreFromZip: (data, onProgress) => {
        restored.push(data);
        for (const stage of [
          "checking",
          "resetting",
          "rebuilding",
          "importing",
          "clearing-caches",
        ] as const) {
          onProgress({ stage, statementCount: 2 });
        }
        return Promise.resolve();
      },
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
      ...overrides,
    },
    promptMessages,
    readPaths,
    restored,
    stderr,
    stdout,
  };
};

describe("restore task", () => {
  test("requires one backup path", async () => {
    const state = cliState({ args: [] });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([RESTORE_USAGE]);
    expect(state.readPaths).toEqual([]);
  });

  test("requires DB_URL before reading the backup", async () => {
    const state = cliState({ getEnv: () => undefined });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual(["DB_URL is required in .env."]);
    expect(state.readPaths).toEqual([]);
  });

  test("requires DB_TOKEN for a remote database", async () => {
    const state = cliState({
      getEnv: (key) =>
        key === "DB_URL" ? "libsql://tickets.example.com" : undefined,
    });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "DB_TOKEN is required in .env for a remote database.",
    ]);
  });

  test("refuses an in-memory restore target", async () => {
    const state = cliState({
      getEnv: (key) => (key === "DB_URL" ? ":memory:" : undefined),
    });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "DB_URL cannot be :memory: for a restore. Set it to the target database in .env.",
    ]);
    expect(state.readPaths).toEqual([]);
  });

  test("reports a backup file read failure", async () => {
    const state = cliState({
      readFile: () => Promise.reject(new Error("permission denied")),
    });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Could not read backup.zip: permission denied",
    ]);
  });

  test("rejects an invalid ZIP before asking for confirmation", async () => {
    const state = cliState({
      readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr[0]).toBe("backup.zip is not a valid database backup.");
    expect(state.promptMessages).toEqual([]);
  });

  test("stops when the confirmation does not match", async () => {
    const state = cliState({ prompt: () => "restore" });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "Restore cancelled. The database was not changed.",
    ]);
    expect(state.restored).toEqual([]);
  });

  test("shows backup details and every restore phase", async () => {
    const state = cliState({
      getEnv: (key) =>
        key === "DB_URL"
          ? "libsql://tickets.example.com"
          : key === "DB_TOKEN"
            ? "secret"
            : undefined,
      readRecordedScriptCommit: () => Promise.resolve(FULL_COMMIT),
    });

    expect(await runRestoreCli(state.deps)).toBe(0);
    expect(state.stderr).toEqual([]);
    expect(state.stdout).toContain(
      "Target database: libsql://tickets.example.com",
    );
    expect(state.stdout).toContain("Backup created: 2026-07-22T12:00:00.000Z");
    expect(state.stdout).toContain(
      "Backup contents: 1 table, 2 rows, 2 SQL statements",
    );
    expect(state.stdout).toContain("Schema: matches this version of the app");
    expect(state.stdout).toContain("Checking 2 SQL statements...");
    expect(state.stdout).toContain("Deleting current database data...");
    expect(state.stdout).toContain("Recreating the database schema...");
    expect(state.stdout).toContain("Importing 2 SQL statements...");
    expect(state.stdout).toContain("Clearing cached database data...");
    expect(state.stdout).toContain("Database restored successfully.");
    expect(state.stdout).toContain(
      `The backup was running commit ${FULL_COMMIT}.`,
    );
    expect(state.stdout.join("\n")).not.toContain("secret");
    expect(state.restored).toHaveLength(1);
    expect(state.promptMessages).toEqual([
      `Type ${RESTORE_CONFIRMATION} to continue:`,
    ]);
  });

  test("warns when the backup schema differs", async () => {
    const state = cliState({
      readFile: () =>
        Promise.resolve(
          backupZip({
            latestUpdate: "A different layout",
            schemaHash: "different",
            tables: { settings: 3 },
            timestamp: "2026-07-01T00:00:00.000Z",
          }),
        ),
    });

    expect(await runRestoreCli(state.deps)).toBe(0);
    expect(state.stderr).toContain(
      "Warning: This backup uses a different database schema. The app may need to apply database updates after the restore.",
    );
  });

  test("handles an older backup without a manifest", async () => {
    const state = cliState({
      readFile: () => Promise.resolve(backupZip(null)),
      readRecordedScriptCommit: () => Promise.resolve("not-a-full-sha"),
    });

    expect(await runRestoreCli(state.deps)).toBe(0);
    expect(state.stdout).toContain("Backup manifest: not available");
    expect(state.stdout.some((line) => line.includes("commit"))).toBe(false);
  });

  test("reports a failure that leaves the old database intact", async () => {
    const state = cliState({
      restoreFromZip: () => Promise.reject(new Error("newer backup")),
    });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toContain("Restore failed: newer backup");
    expect(state.stderr.some((line) => line.includes("was reset"))).toBe(false);
  });

  test("makes a post-reset restore failure explicit", async () => {
    const state = cliState({
      restoreFromZip: () =>
        Promise.reject(new PostResetError("database import failed")),
    });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toContain("Restore failed: database import failed");
    expect(state.stderr).toContain(
      "The target database was reset before the restore failed. Fix the error and run the restore again.",
    );
  });

  test("reports when restored build information cannot be read", async () => {
    const state = cliState({
      readRecordedScriptCommit: () =>
        Promise.reject(new Error("settings unavailable")),
    });

    expect(await runRestoreCli(state.deps)).toBe(1);
    expect(state.stderr).toEqual([
      "The database was restored, but its build information could not be read: settings unavailable",
    ]);
  });
});
