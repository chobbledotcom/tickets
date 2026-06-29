#!/usr/bin/env -S deno run --allow-all
/**
 * Precommit mutation gate — entry point.
 *
 * Mutation-tests every `src/` file this branch changed (vs origin/main) against
 * every changed `test/` file and demands a 100% kill rate (known-equivalent
 * mutants recorded in scripts/mutation/equivalent-mutants.txt aside). See
 * ./precommit/mutation-step.ts for the rationale; the source→test mapping is
 * simply the changed set, because the project's 100%-coverage rule lands a src
 * change with its covering test in the same commit range.
 *
 * Real git and mutation-runner wiring lives here, away from the unit-tested
 * pure logic, so this side-effecting file is never imported by tests (matching
 * scripts/precommit.ts).
 */

import { join } from "@std/path";
import { runMutationTesting } from "./mutation/runner.ts";
import { runCommand } from "./precommit/merge-warning.ts";
import { runMutationStep } from "./precommit/mutation-step.ts";
import { projectRoot } from "./test-harness.ts";

/** Per-mutant timeout floor; mirrors `deno task mutation`'s default. */
const MUTANT_TIMEOUT_MS = 10_000;

/** git diff yields repo-relative paths; the runner's ignore-list matching needs
 *  the absolute form so its `rel()` recovers the repo-relative key. */
const absolute = (paths: string[]): string[] =>
  paths.map((path) => join(projectRoot, path));

if (import.meta.main) {
  const code = await runMutationStep({
    log: (message) => console.log(message),
    run: runCommand,
    runMutation: ({ sources, tests }) =>
      runMutationTesting({
        exhaustive: false,
        sourceFiles: absolute(sources),
        testFiles: absolute(tests),
        timeout: MUTANT_TIMEOUT_MS,
        useHarness: true,
      }),
  });
  Deno.exit(code);
}
