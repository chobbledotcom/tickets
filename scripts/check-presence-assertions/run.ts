/**
 * IO shell for the presence-assertion check: scans the test tree and holds
 * every test file to its recorded `toBeDefined()` count (see "Test Quality
 * Standards" in AGENTS.md). Kept thin so the logic stays testable.
 */

import { type Counts, registryCheck } from "#scripts/check-runner.ts";
import { collectFiles } from "#scripts/walk-files.ts";
import { countsByPath, findIssues, presenceFindings } from "./rules.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/;
const REGISTRY = "scripts/check-presence-assertions/registry.json";

const collectTestFiles = (root: string): Promise<string[]> =>
  collectFiles(root, (path) => TEST_FILE_PATTERN.test(path));

/** Every test file's count, files without a finding left out, so a cleared
 * file drops its registry entry on the next `--update`. */
export const filesWithPresence = async (): Promise<Counts> => {
  const files = await collectTestFiles("test");
  const perFile = await Promise.all(
    files.map(async (file) =>
      presenceFindings(file, await Deno.readTextFile(file)),
    ),
  );
  return countsByPath(perFile.flat());
};

/** Check every test file for `toBeDefined()` calls past its recorded count. */
export const runPresenceCheck = registryCheck(
  collectTestFiles,
  findIssues,
  REGISTRY,
  {
    guide: '"Test Quality Standards" in AGENTS.md',
    noun: "presence-only assertion",
    success:
      "No test file holds more presence-only assertions than its recorded count.",
  },
);
