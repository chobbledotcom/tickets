/**
 * Precommit mutation gate — pure logic.
 *
 * The project requires 100% test coverage, so a change to a `src/` file lands
 * in the same commit as the change to the `test/` file that covers it. That
 * makes the *staged* set its own source→test mapping: mutate every staged src
 * file, run every staged test file against the mutants, and demand a 100% kill
 * rate. The whole src file is mutated regardless of how little of it changed.
 *
 * Everything here is pure and dependency-injected so it is unit-testable
 * without spawning git or the mutation runner; the thin entry
 * `scripts/precommit-mutation.ts` wires in the real implementations.
 */

import type { RunCommand } from "./merge-warning.ts";

/** The staged paths split into the src files to mutate and tests to run. */
export interface StagedFiles {
  sources: string[];
  tests: string[];
}

/** Dependency-injected runner for one mutation pass; resolves to an exit code. */
export type RunMutation = (files: StagedFiles) => Promise<number>;

export interface MutationStepDeps {
  log: (message: string) => void;
  run: RunCommand;
  runMutation: RunMutation;
}

const isSourceFile = (path: string): boolean =>
  path.startsWith("src/") && (path.endsWith(".ts") || path.endsWith(".tsx"));

const isTestFile = (path: string): boolean =>
  path.startsWith("test/") && path.endsWith(".test.ts");

/** Split staged paths into the src files we mutate and the tests we run. A
 *  path that is neither (docs, scripts, config) is dropped. */
export const partitionStaged = (paths: string[]): StagedFiles => ({
  sources: paths.filter(isSourceFile),
  tests: paths.filter(isTestFile),
});

/** Paths staged for the commit, limited to files that still exist (added,
 *  copied, modified, renamed — deletions are excluded so we never mutate a
 *  file that is gone). */
export const stagedPaths = async (run: RunCommand): Promise<string[]> => {
  const result = await run([
    "git",
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
  ]);
  if (!result.success) {
    throw new Error(`git diff --cached failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
};

/**
 * Run the mutation gate over the staged files, returning a precommit exit code.
 *
 *   - No staged src files → nothing to prove; pass.
 *   - Staged src but no staged tests → skip (pass). There are no staged tests
 *     to mutate against, and there is no way to add one without artificially
 *     editing an unchanged test (staging an unmodified file produces no diff).
 *     The 100%-coverage gate still applies; stage a covering test to
 *     mutation-check the change.
 *   - Both → mutate every staged src file against every staged test file. The
 *     runner's exit code passes through, except code 2 ("no mutable operators
 *     in any staged src file", e.g. a types-only or re-export change) becomes a
 *     pass — there is genuinely nothing to mutate.
 */
export const runMutationStep = async (
  deps: MutationStepDeps,
): Promise<number> => {
  const staged = partitionStaged(await stagedPaths(deps.run));
  if (staged.sources.length === 0) {
    deps.log("No staged src files — nothing to mutation-test.");
    return 0;
  }
  if (staged.tests.length === 0) {
    deps.log(
      "Staged src changes but no staged test files — skipping mutation. " +
        "Stage a test that covers the change to mutation-check it.",
    );
    return 0;
  }
  deps.log(
    `Mutation-testing ${staged.sources.length} staged src file(s) against ` +
      `${staged.tests.length} staged test file(s); every mutant must be killed.`,
  );
  const code = await deps.runMutation(staged);
  return code === 2 ? 0 : code;
};
