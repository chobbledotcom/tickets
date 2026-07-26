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
import { cachingReader, collectTestSubjects } from "./test-subjects.ts";
import { collectFiles } from "./walk-files.ts";

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
      testSubjects: async () => {
        const importMap = JSON.parse(
          await Deno.readTextFile("deno.json"),
        ).imports;
        const readText = cachingReader((path: string) =>
          Deno.readTextFile(path),
        );
        const testTreeFiles = new Set(await collectFiles("test", () => true));
        const entries = await Promise.all(
          [...testTreeFiles]
            .filter((path) => /\.test\.tsx?$/.test(path))
            .map(
              async (path) =>
                [
                  path,
                  await collectTestSubjects(
                    path,
                    readText,
                    importMap,
                    testTreeFiles,
                  ),
                ] as const,
            ),
        );
        return new Map(entries);
      },
    }),
  );
  Deno.exit(code);
}
