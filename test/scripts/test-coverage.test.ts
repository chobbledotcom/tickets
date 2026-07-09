import { dirname, join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bracket } from "#fp";
import { removeOldCoverageOutput } from "../../scripts/coverage-output.ts";

const withTempCoverageDir = bracket(
  async () => join(await Deno.makeTempDir(), "coverage"),
  (coverageDir: string) =>
    Deno.remove(dirname(coverageDir), { recursive: true }).catch(() => {}),
);

const withTempFile = bracket(
  () => Deno.makeTempFile(),
  (path: string) => Deno.remove(path).catch(() => {}),
);

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

describe("removeOldCoverageOutput", () => {
  test("removes stale coverage files before a coverage run", async () => {
    await withTempCoverageDir(async (coverageDir) => {
      const staleFile = join(coverageDir, "old.json");
      await Deno.mkdir(coverageDir);
      await Deno.writeTextFile(staleFile, "stale coverage");

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
      await expect(
        removeOldCoverageOutput(join(filePath, "coverage")),
      ).rejects.toThrow(Deno.errors.NotADirectory);
    });
  });
});
