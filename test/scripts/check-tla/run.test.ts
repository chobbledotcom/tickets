import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { it as test } from "@std/testing/bdd";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { collectTlaSources } from "#scripts/tla/files.ts";
import { tempDir } from "#test-utils/files.ts";

test("an unregistered source reports failure before source reads", async () => {
  const sources = await collectTlaSources(["verification"]);
  const errors: string[] = [];
  const logged: string[] = [];
  const result = await checkVerification(
    { log: logged.push.bind(logged), logError: errors.push.bind(errors) },
    {
      collect: () =>
        Promise.resolve([...sources, resolve("verification/Unregistered.tla")]),
      stat: Deno.stat,
    },
  );
  expect(result).toBe(1);
  expect(logged).toEqual([]);
  expect(errors[0]).toMatch(
    /\[unregistered-module\].*verification\/Unregistered\.tla/,
  );
});

test("a directory cannot stand in for a declared review source", async () => {
  using dir = tempDir();
  const directory = await Deno.stat(dir.path);
  await expect(
    checkVerification(undefined, {
      collect: collectTlaSources,
      stat: () => Promise.resolve(directory),
    }),
  ).rejects.toThrow(/review context is not a source file/);
});
