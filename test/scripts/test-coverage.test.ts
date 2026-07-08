import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { clearCoverageDir } from "../../scripts/test-coverage.ts";

const withTempDir = async (
  useDir: (path: string) => Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempDir();
  try {
    await useDir(path);
  } finally {
    await Deno.remove(path, { recursive: true }).catch(() => {});
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

describe("clearCoverageDir", () => {
  test("removes stale coverage files before a coverage run", async () => {
    await withTempDir(async (dir) => {
      const coverageDir = join(dir, "coverage");
      const staleFile = join(coverageDir, "old.json");
      await Deno.mkdir(coverageDir);
      await Deno.writeTextFile(staleFile, "stale coverage");

      await clearCoverageDir(coverageDir);

      expect(await pathExists(coverageDir)).toBe(false);
    });
  });

  test("allows a missing coverage directory on the first run", async () => {
    await withTempDir(async (dir) => {
      const coverageDir = join(dir, "coverage");

      await clearCoverageDir(coverageDir);

      expect(await pathExists(coverageDir)).toBe(false);
    });
  });

  test("fails if the coverage directory cannot be removed cleanly", async () => {
    await expect(clearCoverageDir("\0")).rejects.toThrow();
  });
});
