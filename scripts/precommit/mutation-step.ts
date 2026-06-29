/**
 * Precommit mutation gate — pure logic.
 *
 * `deno task precommit` runs *after* you have committed, on a clean tree (its
 * push prompt only fires when `git status` is empty), so the git index is empty
 * and there is nothing staged to inspect. The gate therefore works from the
 * branch's *committed* diff against a base ref, using `base...HEAD` so only this
 * branch's own commits count.
 *
 * The base ref mirrors how `push.ts` decides what to push: it prefers the
 * branch's own upstream (`@{upstream}`) when set, falling back to `origin/main`
 * then a local `main`. Preferring the upstream keeps the diff bounded to the
 * branch's own work even when the local `main`/`origin/main` is far behind the
 * real one — diffing a stale `origin/main` would otherwise balloon the changed
 * set to the whole tree and try to mutate everything.
 *
 * It mutates every changed `src/` file, runs every changed `test/` file against
 * the mutants, and demands a 100% kill rate. The whole src file is mutated
 * regardless of how little of it changed. Because the project requires 100%
 * coverage, a src change lands in the same commit range as the test change that
 * covers it, so the changed set is its own source→test mapping.
 *
 * Known limitations (this is a deliberately mapping-free, best-effort *local*
 * check; `deno task mutation` is the precise manual tool):
 *
 *   - Committed-only. It scopes to `base...HEAD`, not the working tree, so
 *     *uncommitted* changes are not mutation-checked until committed. The
 *     canonical flow — commit, then `deno task precommit`, then push — runs on a
 *     clean tree where the worktree already equals HEAD, so this only affects
 *     dirty pre-checks. Commit (even a WIP commit) to bring changes under it.
 *   - No real source→test pairing. It runs *all* changed tests against *all*
 *     changed src, trusting that a src change ships with its covering test. If a
 *     changed src file's covering test is *unchanged* while an *unrelated* test
 *     file also changed in the range, that src is mutated only against the
 *     unrelated test and can report false survivors. Touch the covering test
 *     too, or verify that file with `deno task mutation` directly.
 *
 * Everything here is pure and dependency-injected so it is unit-testable
 * without spawning git or the mutation runner; the thin entry
 * `scripts/precommit-mutation.ts` wires in the real implementations.
 */

import type { RunCommand } from "./merge-warning.ts";

/** The changed paths split into the src files to mutate and tests to run. */
export interface ChangedFiles {
  sources: string[];
  tests: string[];
}

/** Dependency-injected runner for one mutation pass; resolves to an exit code. */
export type RunMutation = (files: ChangedFiles) => Promise<number>;

export interface MutationStepDeps {
  log: (message: string) => void;
  run: RunCommand;
  runMutation: RunMutation;
}

const isSourceFile = (path: string): boolean =>
  path.startsWith("src/") &&
  (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js"));

const isTestFile = (path: string): boolean =>
  path.startsWith("test/") &&
  (path.endsWith(".test.ts") || path.endsWith(".test.tsx"));

/** Split changed paths into the src files we mutate and the tests we run. A
 *  path that is neither (docs, scripts, config) is dropped. */
export const partitionChanged = (paths: string[]): ChangedFiles => ({
  sources: paths.filter(isSourceFile),
  tests: paths.filter(isTestFile),
});

/** This branch's own upstream ref (e.g. `origin/feature`), or null when the
 *  branch has no upstream set. Preferred base: it tracks what this branch has
 *  pushed, so the diff stays bounded to the branch's own commits even when the
 *  local `main`/`origin/main` is far behind the real one. */
const upstreamRef = async (run: RunCommand): Promise<string | null> => {
  const result = await run([
    "git",
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (!result.success) return null;
  const value = result.stdout.trim();
  return value === "" ? null : value;
};

/** The first of `refs` that resolves to a commit, or null when none do. */
const firstExistingRef = async (
  run: RunCommand,
  refs: string[],
): Promise<string | null> => {
  for (const ref of refs) {
    const result = await run(["git", "rev-parse", "--verify", "--quiet", ref]);
    if (result.success) return ref;
  }
  return null;
};

/** The base ref to diff against: this branch's upstream when set, else the
 *  integration branch (`origin/main`, then a local `main`). Null when none
 *  resolve, so the caller skips rather than mutating the whole tree. */
const resolveBaseRef = async (run: RunCommand): Promise<string | null> => {
  const upstream = await upstreamRef(run);
  if (upstream !== null) return upstream;
  return firstExistingRef(run, ["origin/main", "main"]);
};

/**
 * The src/test files this branch changes relative to its base ref, via
 * `base...HEAD` (the merge-base of base and HEAD, to HEAD) so only the branch's
 * own commits count — limited to files that still exist (added, copied,
 * modified, renamed; deletions excluded). Null when no base ref can be
 * resolved, so the caller can skip rather than mutate the whole tree.
 */
export const changedFiles = async (
  run: RunCommand,
): Promise<ChangedFiles | null> => {
  const base = await resolveBaseRef(run);
  if (base === null) return null;
  const result = await run([
    "git",
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${base}...HEAD`,
  ]);
  if (!result.success) {
    throw new Error(`git diff ${base}...HEAD failed: ${result.stderr.trim()}`);
  }
  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return partitionChanged(paths);
};

/**
 * Run the mutation gate over the branch's changed files, returning a precommit
 * exit code.
 *
 *   - No base ref to diff against → skip (pass); we cannot scope the run, and
 *     the coverage gate still applies.
 *   - No changed src files → nothing to prove; pass.
 *   - Changed src but no changed tests → skip (pass). There are no changed
 *     tests to mutate against; the 100%-coverage gate still applies, and
 *     changing a covering test brings the change under the gate.
 *   - Both → mutate every changed src file against every changed test file. The
 *     runner's exit code passes through, except code 2 ("no mutable operators
 *     in any changed src file", e.g. a types-only or re-export change) becomes a
 *     pass — there is genuinely nothing to mutate.
 */
export const runMutationStep = async (
  deps: MutationStepDeps,
): Promise<number> => {
  const changed = await changedFiles(deps.run);
  if (changed === null) {
    deps.log(
      "No upstream, origin/main, or main to diff against — skipping mutation.",
    );
    return 0;
  }
  if (changed.sources.length === 0) {
    deps.log("No changed src files — nothing to mutation-test.");
    return 0;
  }
  if (changed.tests.length === 0) {
    deps.log(
      "Changed src files but no changed test files — skipping mutation. " +
        "Change a test that covers them to mutation-check the change.",
    );
    return 0;
  }
  deps.log(
    `Mutation-testing ${changed.sources.length} changed src file(s) against ` +
      `${changed.tests.length} changed test file(s); every mutant must be killed.`,
  );
  const code = await deps.runMutation(changed);
  return code === 2 ? 0 : code;
};
