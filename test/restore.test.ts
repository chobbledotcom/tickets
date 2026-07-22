import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { RESTORE_USAGE } from "#scripts/restore-lib.ts";
import { runRestoreTask } from "#src/restore.ts";
import { TEST_ENCRYPTION_KEY } from "#test-utils/internal.ts";

test("uses only file database settings when running the restore CLI", async () => {
  const env: Record<string, string> = {
    DB_ENCRYPTION_KEY: "ambient-key",
    DB_TOKEN: "ambient-token",
    DB_URL: ":memory:",
    OTHER_KEY: "unchanged",
  };
  const stderr: string[] = [];
  let result: number | undefined;

  await runRestoreTask(
    {
      DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      DB_URL: "libsql://tickets.example.com",
    },
    (key, value) =>
      value === undefined
        ? Reflect.deleteProperty(env, key)
        : Reflect.set(env, key, value),
    async (run) => {
      result = await run({
        args: [],
        getEnv: () => undefined,
        stderr: (line) => stderr.push(line),
        stdout: () => {},
      });
    },
  );

  expect(env).toEqual({
    DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB_URL: "libsql://tickets.example.com",
    OTHER_KEY: "unchanged",
  });
  expect(result).toBe(1);
  expect(stderr).toEqual([RESTORE_USAGE]);
});

test("default restore dependencies read the requested backup path", async () => {
  const path = `missing-restore-${crypto.randomUUID()}.zip`;
  const env: Record<string, string> = {
    DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB_URL: "file:target.db",
  };
  const stderr: string[] = [];
  let result: number | undefined;

  await runRestoreTask(
    env,
    (key, value) =>
      value === undefined
        ? Reflect.deleteProperty(env, key)
        : Reflect.set(env, key, value),
    async (run) => {
      result = await run({
        args: [path],
        getEnv: (key) => env[key],
        stderr: (line) => stderr.push(line),
        stdout: () => {},
      });
    },
  );

  expect(result).toBe(1);
  expect(stderr[0]).toContain(`Could not read ${path}`);
});
