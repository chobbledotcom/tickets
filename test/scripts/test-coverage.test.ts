import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { removeOldCoverageOutput } from "#scripts/coverage-output.ts";
import { pathExists, withTempDir, withTempFile } from "#test-utils/files.ts";

const withTempCoverageDir = <Result>(
  run: (path: string) => Result | Promise<Result>,
): Promise<Result> => withTempDir((root) => run(join(root, "coverage")));

describe("removeOldCoverageOutput", () => {
  test("removes stale coverage files before a coverage run", async () => {
    await withTempCoverageDir(async (coverageDir) => {
      const staleFile = join(coverageDir, "old.json");
      await Deno.mkdir(coverageDir);
      await Deno.writeTextFile(staleFile, "stale coverage");
      expect(await pathExists(coverageDir)).toBe(true);

      await removeOldCoverageOutput(coverageDir);

      expect(await pathExists(coverageDir)).toBe(false);
    });
  });

  test("allows a missing coverage directory on the first run", async () => {
    await withTempCoverageDir(async (coverageDir) => {
      await removeOldCoverageOutput(coverageDir);

      expect(await pathExists(coverageDir)).toBe(false);
    });
  });

  test("surfaces filesystem errors other than missing coverage output", async () => {
    await withTempFile(async (filePath) => {
      await expect(pathExists(join(filePath, "coverage"))).rejects.toThrow(
        Deno.errors.NotADirectory,
      );
      await expect(
        removeOldCoverageOutput(join(filePath, "coverage")),
      ).rejects.toThrow(Deno.errors.NotADirectory);
    });
  });
});
