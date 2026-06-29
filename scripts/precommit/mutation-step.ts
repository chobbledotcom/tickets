/**
 * Precommit mutation gate — pure logic.
 *
 * `deno task precommit` runs *after* you have committed, on a clean tree (its
 * push prompt only fires when `git status` is empty), so the git index is empty
 * and there is nothing staged to inspect. The gate therefore works from the
 * branch's *committed* diff against a base ref, using `base...HEAD` so only this
 * branch's own commits count.
 *
 * The base ref is the integration branch: `origin/main`, falling back to a
 * local `main`. `base...HEAD` is the three-dot (merge-base) form, so in a normal
 * checkout it is the branch's *full* diff against main and only the branch's own
 * commits count, regardless of how far main has advanced or how much of the
 * branch has already been pushed. (Using the branch's own upstream instead would
 * drop already-pushed commits from the range, letting a fully-pushed branch
 * report "no changed src" and skip source changes still in the PR.)
 *
 * If the *local* `origin/main` ref is badly stale (e.g. a fresh shallow clone),
 * the merge-base falls way back and the changed set balloons toward the whole
 * tree. Rather than attempt a multi-hundred-file mutation run, the gate skips
 * with a "run `git fetch origin main`" warning once the changed-source count
 * exceeds `STALE_BASE_SOURCE_LIMIT`.
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

/** A changed-source count above this almost certainly means the local base ref
 *  is stale (the merge-base fell far back), not a real change set — so the gate
 *  skips with a fetch hint rather than mutating most of the tree. Real changes,
 *  even large refactors, stay well under this; bigger ones can be checked with
 *  `deno task mutation` directly. */
export const STALE_BASE_SOURCE_LIMIT = 100;

/** Prefix on the skip/warning notices that must stay visible even when the gate
 *  passes. The precommit runner swallows a successful step's stdout, so these
 *  are re-surfaced via `mutationNoticeSummary` (wired as the step's summary). */
export const MUTATION_NOTICE_PREFIX = "⚠ mutation: ";

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

/** The base ref to diff against: the integration branch — `origin/main`, then a
 *  local `main`. The first that resolves to a commit wins; null when neither
 *  does, so the caller skips rather than mutating the whole tree. */
const resolveBaseRef = async (run: RunCommand): Promise<string | null> => {
  for (const ref of ["origin/main", "main"]) {
    const result = await run(["git", "rev-parse", "--verify", "--quiet", ref]);
    if (result.success) return ref;
  }
  return null;
};

/**
 * The src/test files this branch changes relative to its base ref, via
 * `base...HEAD` (the merge-base of base and HEAD, to HEAD) so only the branch's
 * own commits count — limited to files that still exist (added, copied,
 * modified, renamed; deletions excluded). Null when the diff cannot be scoped —
 * no base ref resolves, or a shallow clone shares no merge base with `base` — so
 * the caller can skip rather than mutate the whole tree or crash precommit.
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
    // A shallow clone whose fetched history shares no commit with HEAD has no
    // merge base, so `base...HEAD` aborts (exit 128, "no merge base"). Treat
    // that as unscopable (skip) rather than failing the whole precommit; any
    // other diff failure is a genuine error and still throws.
    if (/no merge base/i.test(result.stderr)) return null;
    throw new Error(`git diff ${base}...HEAD failed: ${result.stderr.trim()}`);
  }
  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return partitionChanged(paths);
};

/**
 * The notice lines (stale base, no merge base, no changed tests, …) emitted on
 * `stdout`, joined for display — or undefined when there are none. Wired as the
 * mutation step's `summary` so these stay visible even though the precommit
 * runner swallows a passing step's output. A normal mutation *run* emits none,
 * so a clean pass shows nothing extra.
 */
export const mutationNoticeSummary = (stdout: string): string | undefined => {
  const notices = stdout
    .split("\n")
    .filter((line) => line.includes(MUTATION_NOTICE_PREFIX));
  return notices.length > 0 ? notices.join("\n") : undefined;
};

/**
 * Run the mutation gate over the branch's changed files, returning a precommit
 * exit code.
 *
 *   - Unscopable diff (no base ref, or a shallow clone with no merge base) →
 *     skip (pass) with a notice; the coverage gate still applies.
 *   - More than `STALE_BASE_SOURCE_LIMIT` changed src files → skip (pass) with a
 *     fetch hint; the local base ref is almost certainly stale.
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
      `${MUTATION_NOTICE_PREFIX}no base commit to diff against — missing ` +
        "origin/main/main, or a shallow clone with no merge base. If shallow, " +
        "run `git fetch --unshallow`; skipping mutation.",
    );
    return 0;
  }
  if (changed.sources.length > STALE_BASE_SOURCE_LIMIT) {
    deps.log(
      `${MUTATION_NOTICE_PREFIX}${changed.sources.length} changed src files — ` +
        "the local base ref looks stale. Run `git fetch origin main` and retry; " +
        "skipping mutation.",
    );
    return 0;
  }
  if (changed.sources.length === 0) {
    deps.log("No changed src files — nothing to mutation-test.");
    return 0;
  }
  if (changed.tests.length === 0) {
    deps.log(
      `${MUTATION_NOTICE_PREFIX}changed src files but no changed test files — ` +
        "skipping mutation. Change a test that covers them to mutation-check " +
        "the change.",
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
