#!/usr/bin/env -S deno run --allow-all
/**
 * Precommit mutation gate — entry point.
 *
 * Mutation-tests every `src/` file this branch changed (vs origin/main) and
 * demands a 100% kill rate. Mirrored direct tests run first for their source;
 * explicit integration/e2e/Cucumber tests run only for direct-test survivors.
 * Changed shared Cucumber code selects every Feature. See
 * ./precommit/mutation-step.ts for selection details.
 *
 * Real git and mutation-runner wiring lives here, away from the unit-tested
 * pure logic, so this side-effecting file is never imported by tests (matching
 * scripts/precommit.ts).
 */

import { relative } from "node:path";
import { runMutationInSnapshot } from "./mutation/isolation.ts";
import { runCommand } from "./precommit/git.ts";
import { withPrecommitLock } from "./precommit/lock.ts";
import { runMutationStep } from "./precommit/mutation-step.ts";
import { projectRoot } from "./project-root.ts";
import { collectFeaturePaths } from "./specs/catalog.ts";
import { collectTestFiles } from "./test-groups.ts";

const flaggedPaths = (flag: "--source" | "--test", paths: string[]): string[] =>
  paths.flatMap((path) => [flag, path]);

// Operator flags such as `--deadline` pass through to the mutation runner,
// so a branch too large for the default deadline can raise it.
const mutationArgs = (sources: string[], tests: string[]): string[] => [
  ...flaggedPaths("--source", sources),
  ...flaggedPaths("--test", tests),
  "--harness",
  ...Deno.args,
];

if (import.meta.main) {
  const code = await withPrecommitLock(() =>
    runMutationStep({
      allTestFiles: async () =>
        [
          ...(await collectTestFiles(projectRoot)),
          ...(await collectFeaturePaths()),
        ].map((path) => relative(projectRoot, path)),
      log: (message) => console.log(message),
      run: runCommand,
      runMutation: ({ sources, tests }) =>
        runMutationInSnapshot(mutationArgs(sources, tests)),
    }),
  );
  Deno.exit(code);
}
