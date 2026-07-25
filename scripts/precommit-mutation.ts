#!/usr/bin/env -S deno run --allow-all
/**
 * Precommit mutation gate — entry point.
 *
 * Mutation-tests every `src/` file this branch changed (vs origin/main) and
 * demands a 100% kill rate. Mirrored direct tests run first for their source;
 * explicit integration/e2e/Cucumber tests run only for direct-test survivors. See
 * ./precommit/mutation-step.ts for selection details.
 *
 * Real git and mutation-runner wiring lives here, away from the unit-tested
 * pure logic, so this side-effecting file is never imported by tests (matching
 * scripts/precommit.ts).
 */

import { relative } from "node:path";
import { runMutationInSnapshot } from "./mutation/isolation.ts";
import { runCommand } from "./precommit/git.ts";
import { runMutationStep } from "./precommit/mutation-step.ts";
import { projectRoot } from "./project-root.ts";
import { collectTestFiles } from "./test-groups.ts";

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
    allTestFiles: async () =>
      (await collectTestFiles(projectRoot)).map((path) =>
        relative(projectRoot, path),
      ),
    log: (message) => console.log(message),
    run: runCommand,
    runMutation: ({ sources, tests }) =>
      runMutationInSnapshot(mutationArgs(sources, tests)),
  });
  Deno.exit(code);
}
