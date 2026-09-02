#!/usr/bin/env -S deno run --allow-all

/**
 * Scoped coverage probe: run only the given test files with the full harness
 * (same setup as `test:files`), then print the lines and branches this run
 * left uncovered. This is a diagnostic view of a slice. The full
 * `test:coverage` gate stays the authority.
 *
 *   deno task cov:files test/scripts/unread-fields/
 *   deno task cov:files test/scripts/unread-fields/ --only unread-fields
 *
 * `--only <part>` limits the report to files whose path contains `part`.
 * Repeat `--only` to allow several parts. Every other argument goes to
 * `deno test` unchanged.
 */

import { splitFlagValues } from "#scripts/flag-values.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type CoverageFailure,
  findCoverageFailures,
  printFailureSummary,
} from "./coverage-check.ts";
import { COVERAGE_OUTPUT_DIR } from "./coverage-output.ts";
import { captureOutput, denoCommand } from "./process.ts";
import { projectRoot } from "./project-root.ts";
import { runTests, withTestHarness } from "./test-harness.ts";

const usage = (): never => {
  console.error(
    "Usage: deno task cov:files <test-file>... [--only <path-part>]...",
  );
  Deno.exit(1);
};

interface ScopedArgs {
  only: string[];
  testArgs: string[];
}

/** One `--only` value: a real path part, never the flag behind it. */
const onlyPart = (value: string | undefined): string => {
  const part = requireValue(value, "--only needs a path part");
  if (part.startsWith("--")) usage();
  return part;
};

/** The `--only` parts that focus the report, plus the args for `deno test`. */
const scopedArgs = (args: string[]): ScopedArgs => {
  const { rest, values } = splitFlagValues(args, "--only");
  return { only: values.map(onlyPart), testArgs: rest };
};

/** The run's lcov, read straight from `deno coverage`. */
const lcovOfRun = async (): Promise<string> => {
  const captured = await captureOutput(
    denoCommand(["coverage", COVERAGE_OUTPUT_DIR, "--lcov"], {
      cwd: projectRoot,
    }),
  );
  if (!captured.success) {
    throw new Error(`deno coverage failed with code ${captured.code}`);
  }
  return captured.stdout;
};

/** A failure counts when its path holds a part, or when no part was given. */
const matchesOnly = (
  failure: CoverageFailure,
  only: readonly string[],
): boolean =>
  only.length === 0 || only.some((part) => failure.file.includes(part));

const printGapsFor = async (
  failures: CoverageFailure[],
  only: readonly string[],
): Promise<void> => {
  const focused = failures.filter((failure) => matchesOnly(failure, only));
  if (focused.length === 0) {
    console.log(
      only.length === 0
        ? "All files have 100% line and branch coverage."
        : "No gaps among the files matched by --only.",
    );
    return;
  }
  for (const failure of focused) await printFailureSummary(failure);
  const hidden = failures.length - focused.length;
  console.error(
    `\n${focused.length} file(s) with gaps${
      hidden > 0 ? ` (${hidden} more not shown; pass --only to focus)` : ""
    }.`,
  );
  console.error("A scoped run covers only what these tests touch.");
};

const main = async (): Promise<void> => {
  const { only, testArgs } = scopedArgs(Deno.args);
  if (testArgs.length === 0) usage();

  const testCode = await withTestHarness(() => runTests(testArgs, true));
  if (testCode !== 0) Deno.exit(testCode);

  const failures = findCoverageFailures(await lcovOfRun());
  if (failures === null) {
    console.error("No coverage data was collected for this run.");
    Deno.exit(1);
  }
  await printGapsFor(failures, only);
};

main();
