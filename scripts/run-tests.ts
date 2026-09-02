#!/usr/bin/env -S deno run --allow-all

/**
 * Full test runner: builds static assets and starts stripe-mock (via the
 * shared test harness), runs the whole suite, and—with --coverage—enforces
 * 100% line and branch coverage. Generated static assets are cleaned up by the
 * harness once the run completes.
 */

import { findCoverageFailures, printCoverageReport } from "./coverage-check.ts";
import { COVERAGE_OUTPUT_DIR } from "./coverage-output.ts";
import { denoCommand } from "./process.ts";
import { projectRoot } from "./project-root.ts";
import { readSlowTestsReport } from "./test-durations.ts";
import { runSuiteWithHarness } from "./test-harness.ts";

/** Print the coverage table, parse lcov, and enforce 100% line and branch
 *  coverage. */
const checkCoverage = async (): Promise<void> => {
  console.log("\nChecking coverage...");

  const coverageCommand = (
    extraArgs: string[],
    io: Partial<Deno.CommandOptions>,
  ): Deno.Command =>
    denoCommand(["coverage", COVERAGE_OUTPUT_DIR, ...extraArgs], {
      cwd: projectRoot,
      stderr: "inherit",
      ...io,
    });

  const tableCmd = coverageCommand([], {
    stdin: "inherit",
    stdout: Deno.env.get("CI") ? "null" : "inherit",
  });
  await tableCmd.output();

  const lcovCmd = coverageCommand(["--lcov"], { stdout: "piped" });
  const lcovResult = await lcovCmd.output();
  const lcov = new TextDecoder().decode(lcovResult.stdout);

  if ((await printCoverageReport(findCoverageFailures(lcov))) !== 0) {
    Deno.exit(1);
  }
};

/** Main: run the whole suite inside the harness, then enforce coverage */
const main = async (): Promise<void> => {
  const useCoverage = Deno.args.includes("--coverage");
  const exitCode = await runSuiteWithHarness(useCoverage);

  if (exitCode !== 0) Deno.exit(exitCode);
  if (useCoverage) await checkCoverage();
  const slowTestsReport = await readSlowTestsReport();
  if (slowTestsReport) console.log(slowTestsReport);
  Deno.exit(0);
};

main();
