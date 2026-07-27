import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { shouldCopySnapshotPath } from "#scripts/mutation/isolation-state.ts";

/**
 * Every folder a snapshot must leave behind. Each one is either huge, rebuilt
 * on demand, private to the checkout, or a run folder that would nest copies
 * of itself. They are listed here so dropping one from the copier fails a test
 * rather than silently doubling how long every mutation run takes.
 */
const SKIPPED_FOLDERS = [
  ".agents",
  ".claude",
  ".codex",
  ".deno",
  ".deno-cache",
  ".deno_cache",
  ".direnv",
  ".do",
  ".git",
  ".i18n-work",
  ".local-data",
  ".mutation-runs",
  ".pi-worktrees",
  "cov",
  "cov_profile",
  "dist",
  "misc",
  "node_modules",
  // Folders literally named for a value that went missing somewhere.
  "undefined",
  "null",
];

/** Folders skipped by how their name starts, so numbered variants go too. */
const SKIPPED_FOLDER_PREFIXES = ["coverage", ".jscpd", "docs-output"];

/** Files that belong to one checkout only, or that a snapshot rebuilds. */
const SKIPPED_FILES = [
  ".build-tag",
  ".db-key",
  ".env",
  ".static-assets-cache.json",
  ".static-assets-build.lock",
  ".test-junit.xml",
  "bunny-script.ts",
  "bunny-script.ts.map",
];

describe("what a mutation snapshot leaves behind", () => {
  for (const folder of SKIPPED_FOLDERS) {
    test(`leaves the ${folder} folder behind`, () => {
      expect(shouldCopySnapshotPath(`${folder}/inside.ts`)).toBe(false);
    });
  }

  for (const prefix of SKIPPED_FOLDER_PREFIXES) {
    test(`leaves behind folders whose name starts with ${prefix}`, () => {
      expect(shouldCopySnapshotPath(`${prefix}-2/inside.ts`)).toBe(false);
    });
  }

  for (const file of SKIPPED_FILES) {
    test(`leaves the ${file} file behind`, () => {
      expect(shouldCopySnapshotPath(file)).toBe(false);
      // Also wherever else it turns up, not just at the top.
      expect(shouldCopySnapshotPath(`sub/${file}`)).toBe(false);
    });
  }

  test("copies an ordinary source file", () => {
    expect(shouldCopySnapshotPath("src/shared/dates.ts")).toBe(true);
  });

  test("only skips a folder name when it is the top folder", () => {
    // "dist" nested under something else is somebody's ordinary folder.
    expect(shouldCopySnapshotPath("a/dist/notes.md")).toBe(true);
  });

  test("leaves every kind of database file behind", () => {
    expect(shouldCopySnapshotPath("local.db")).toBe(false);
    expect(shouldCopySnapshotPath("local.db-shm")).toBe(false);
    expect(shouldCopySnapshotPath("local.db-wal")).toBe(false);
  });

  test("leaves built browser assets behind", () => {
    expect(shouldCopySnapshotPath("src/ui/static/admin.js")).toBe(false);
    expect(shouldCopySnapshotPath("src/ui/static/style.css")).toBe(false);
  });

  test("copies a script that is built but does not live in the assets folder", () => {
    expect(shouldCopySnapshotPath("src/ui/client/admin.js")).toBe(true);
  });

  test("copies a file in the assets folder that is not a built asset", () => {
    expect(shouldCopySnapshotPath("src/ui/static/notes.txt")).toBe(true);
  });

  test("copies anything it cannot name", () => {
    expect(shouldCopySnapshotPath("")).toBe(true);
  });
});
