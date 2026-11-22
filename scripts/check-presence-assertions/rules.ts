/**
 * Block the presence-only `toBeDefined()` matcher in the test tree.
 *
 * The test-quality gate fails on a weak assertion the branch adds. This
 * check holds every test file to its recorded `toBeDefined()` count in
 * `registry.json`, and the count only falls (see "Test Quality Standards"
 * in AGENTS.md). The exact matcher `toBeUndefined()` stays allowed where
 * the code documents an absent value, so the pattern names `toBeDefined`
 * alone.
 */

import {
  type Counts,
  findingsPastRecord,
  type PerFileFinding,
} from "#scripts/check-runner.ts";
import {
  findWeakPattern,
  type TestQualityFinding,
} from "#scripts/test-quality-audit-model.ts";

/** The matcher this check counts, in comment-and-string-blanked code. */
export const PRESENCE_PATTERN = /\.toBeDefined\s*\(\s*\)/g;

const RULE = "presence-only";
const PROBLEM = "presence-only assertion: toBeDefined() checks presence alone";
const FIX = "assert the value, shape, or invariant instead";

const UPDATE_COMMAND = "deno task check:presence-assertions --update";

/** Every `toBeDefined()` call in one test file, with its position. */
export const presenceFindings = (
  path: string,
  content: string,
): TestQualityFinding[] =>
  findWeakPattern(path, content, { message: RULE, pattern: PRESENCE_PATTERN });

/** One file's findings against its recorded count: the calls past the count
 * fail, a fallen count asks for its record, and a file with no call left but
 * an entry asks for the entry's deletion. */
export const findIssues = (
  file: string,
  content: string,
  accepted: Counts,
): PerFileFinding[] =>
  findingsPastRecord(
    file,
    presenceFindings(file, content),
    accepted,
    {
      clean: "holds no presence-only assertion",
      fewer: (count, recorded) =>
        `holds ${count} presence-only assertions, fewer than the recorded ${recorded}`,
      registry: "scripts/check-presence-assertions/registry.json",
      updateCommand: UPDATE_COMMAND,
    },
    (finding) => ({
      fix: FIX,
      line: finding.line,
      problem: PROBLEM,
      rule: RULE,
    }),
  );
