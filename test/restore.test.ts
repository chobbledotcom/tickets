import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { RESTORE_USAGE } from "#scripts/restore-lib.ts";
import { runRestoreTask } from "#src/restore.ts";

test("loads file environment before running the restore CLI", async () => {
  const env = { DB_TOKEN: "ambient", DB_URL: ":memory:" };
  const stderr: string[] = [];
  let result: number | undefined;

  await runRestoreTask(
    {
      DB_TOKEN: "file-token",
      DB_URL: "libsql://tickets.example.com",
    },
    (key, value) => Reflect.set(env, key, value),
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
    DB_TOKEN: "file-token",
    DB_URL: "libsql://tickets.example.com",
  });
  expect(result).toBe(1);
  expect(stderr).toEqual([RESTORE_USAGE]);
});

test("default restore dependencies read the requested backup path", async () => {
  const path = `missing-restore-${crypto.randomUUID()}.zip`;
  const stderr: string[] = [];
  let result: number | undefined;

  await runRestoreTask(
    {},
    () => {},
    async (run) => {
      result = await run({
        args: [path],
        getEnv: (key) => (key === "DB_URL" ? "file:target.db" : undefined),
        stderr: (line) => stderr.push(line),
        stdout: () => {},
      });
    },
  );

  expect(result).toBe(1);
  expect(stderr[0]).toContain(`Could not read ${path}`);
});
