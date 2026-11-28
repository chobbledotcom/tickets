/**
 * Block the presence-only `toBeDefined()` matcher in the test tree.
 *
 * Every `toBeDefined()` call in a test file is a finding. The check has no
 * exceptions list (see "Test Quality Standards" in AGENTS.md). The exact
 * matcher `toBeUndefined()` stays allowed where the code documents an absent
 * value, so the pattern names `toBeDefined` alone.
 */

import type { PerFileFinding } from "#scripts/check-runner.ts";
import {
  findWeakPattern,
  type TestQualityFinding,
} from "#scripts/test-quality-audit-model.ts";

/** The matcher this check reports, in comment-and-string-blanked code. */
export const PRESENCE_PATTERN = /\.toBeDefined\s*\(\s*\)/g;

const RULE = "presence-only";
const PROBLEM = "presence-only assertion: toBeDefined() checks presence alone";
const FIX = "assert the value, shape, or invariant instead";

/** Every `toBeDefined()` call in one test file, with its position. */
export const presenceFindings = (
  path: string,
  content: string,
): TestQualityFinding[] =>
  findWeakPattern(path, content, { message: RULE, pattern: PRESENCE_PATTERN });

/** Every `toBeDefined()` call in one test file, as a finding. */
export const findIssues = (file: string, content: string): PerFileFinding[] =>
  presenceFindings(file, content).map((finding) => ({
    fix: FIX,
    line: finding.line,
    problem: PROBLEM,
    rule: RULE,
  }));
