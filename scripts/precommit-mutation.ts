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

import { runMutationInSnapshot } from "./mutation/isolation.ts";
import { runCommand } from "./precommit/git.ts";
import { runMutationStep } from "./precommit/mutation-step.ts";

/** Per-mutant timeout floor; mirrors `deno task mutation`'s default. */
const MUTANT_TIMEOUT_MS = 10_000;

const flaggedPaths = (flag: "--source" | "--test", paths: string[]): string[] =>
  paths.flatMap((path) => [flag, path]);

const mutationArgs = (sources: string[], tests: string[]): string[] => [
  ...flaggedPaths("--source", sources),
  ...flaggedPaths("--test", tests),
  "--timeout",
  String(MUTANT_TIMEOUT_MS),
  "--harness",
];

if (import.meta.main) {
  const code = await runMutationStep({
    log: (message) => console.log(message),
    run: runCommand,
    runMutation: ({ sources, tests }) =>
      runMutationInSnapshot(mutationArgs(sources, tests)),
  });
  Deno.exit(code);
}
