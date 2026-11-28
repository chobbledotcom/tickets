/**
 * IO shell for the presence-assertion check: scans the test tree and reports
 * every `toBeDefined()` call (see "Test Quality Standards" in AGENTS.md).
 * Kept thin so the logic stays testable.
 */

import { perFileCheck } from "#scripts/check-runner.ts";
import { collectFiles } from "#scripts/walk-files.ts";
import { findIssues } from "./rules.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/;

const collectTestFiles = (root: string): Promise<string[]> =>
  collectFiles(root, (path) => TEST_FILE_PATTERN.test(path));

/** Check every test file for `toBeDefined()` calls. */
export const runPresenceCheck = perFileCheck(collectTestFiles, findIssues, {
  guide: '"Test Quality Standards" in AGENTS.md',
  noun: "presence-only assertion",
  success: "No test file holds a presence-only assertion.",
});
