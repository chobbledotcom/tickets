#!/usr/bin/env -S deno run --allow-all
/**
 * Full test runner: builds static assets and starts stripe-mock (via the
 * shared test harness), runs the whole suite, and—with --coverage—enforces
 * 100% line and branch coverage. Generated static assets are cleaned up by the
 * harness once the run completes.
 */

import { join } from "node:path";
import { projectRoot, runTests, withTestHarness } from "./test-harness.ts";

/** Extract uncovered line numbers from DA: entries in an lcov record */
const extractUncoveredLines = (record: string): number[] => {
  const matches = record.matchAll(/^DA:(\d+),0$/gm);
  const lines: number[] = [];
  for (const m of matches) lines.push(parseInt(m[1], 10));
  return lines;
};

/** Extract uncovered branch line numbers from BRDA: entries, deduped */
const extractUncoveredBranchLines = (record: string): number[] => {
  const matches = record.matchAll(/^BRDA:(\d+),\d+,\d+,(-|0)$/gm);
  const seen = new Set<number>();
  const lines: number[] = [];
  for (const m of matches) {
    const line = parseInt(m[1], 10);
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
};

/** Format uncovered numbers as an indented suffix, or "" if none */
const formatUncovered = (label: string, nums: number[]): string => {
  if (nums.length === 0) return "";
  return `\n      uncovered ${label}: ${nums.join(", ")}`;
};

/** Check a coverage metric (lines or branches) in an lcov record */
const checkMetric = (
  record: string,
  hitKey: string,
  foundKey: string,
  file: string,
  label: string,
  uncoveredSuffix: string,
): string | undefined => {
  const hitMatch = record.match(new RegExp(`${hitKey}:(\\d+)`));
  const foundMatch = record.match(new RegExp(`${foundKey}:(\\d+)`));
  if (!hitMatch || !foundMatch) return undefined;
  const hit = parseInt(hitMatch[1], 10);
  const found = parseInt(foundMatch[1], 10);
  return hit < found
    ? `${file}: ${hit}/${found} ${label} covered${uncoveredSuffix}`
    : undefined;
};

// Files excluded from coverage enforcement
const COVERAGE_EXCLUSIONS = ["src/shared/db/migrations.ts", "test/test-utils/"];

/** Extract the relative file path from an lcov record, or null if excluded */
const extractRecordFile = (record: string): string | null => {
  const sfMatch = record.match(/SF:(.*)/);
  if (!sfMatch) return null;
  const file = sfMatch[1].replace(`${projectRoot}/`, "");
  if (COVERAGE_EXCLUSIONS.some((exclusion) => file.includes(exclusion))) {
    return null;
  }
  return file;
};

/** Check both line and branch coverage for a single lcov record */
const checkRecord = (
  record: string,
  file: string,
  lineFailures: string[],
  branchFailures: string[],
): void => {
  const lineSuffix = formatUncovered("lines", extractUncoveredLines(record));
  const branchSuffix = formatUncovered(
    "branches (by line)",
    extractUncoveredBranchLines(record),
  );
  const lineFail = checkMetric(record, "LH", "LF", file, "lines", lineSuffix);
  if (lineFail) lineFailures.push(lineFail);
  const branchFail = checkMetric(
    record,
    "BRH",
    "BRF",
    file,
    "branches",
    branchSuffix,
  );
  if (branchFail) branchFailures.push(branchFail);
};

/** Parse lcov records and return coverage failures */
const findCoverageFailures = (
  lcov: string,
): { lineFailures: string[]; branchFailures: string[] } => {
  const records = lcov.split("end_of_record").filter((r) => r.includes("SF:"));
  if (records.length === 0) {
    return { branchFailures: [], lineFailures: ["No coverage data found"] };
  }

  const lineFailures: string[] = [];
  const branchFailures: string[] = [];
  for (const record of records) {
    const file = extractRecordFile(record);
    if (file) checkRecord(record, file, lineFailures, branchFailures);
  }
  return { branchFailures, lineFailures };
};

/** Print a labeled list of failures */
const printFailureCategory = (label: string, failures: string[]): void => {
  if (failures.length === 0) return;
  console.error(`\n${label}:`);
  for (const f of failures) console.error(`  ${f}`);
};

/** Report coverage failures and exit if any */
const reportCoverageFailures = (
  lineFailures: string[],
  branchFailures: string[],
): void => {
  if (lineFailures.length === 0 && branchFailures.length === 0) {
    console.log("\nAll files have 100% line and branch coverage");
    return;
  }
  printFailureCategory("Line coverage is not 100%", lineFailures);
  printFailureCategory("Branch coverage is not 100%", branchFailures);
  console.error("\nTest quality rules:");
  console.error("  - 100% line coverage is required");
  console.error("  - 100% branch coverage is required");
  console.error("  - Test outcomes not implementations");
  console.error("  - Test-only exports are forbidden");
  console.error("  - Tautological tests are forbidden");
  Deno.exit(1);
};

/** Run coverage check: print table, parse lcov, enforce 100% */
const checkCoverage = async (): Promise<void> => {
  console.log("\nChecking coverage...");
  const coverageDir = join(projectRoot, "coverage");

  const tableCmd = new Deno.Command(Deno.execPath(), {
    args: ["coverage", coverageDir],
    cwd: projectRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  await tableCmd.output();

  const lcovCmd = new Deno.Command(Deno.execPath(), {
    args: ["coverage", coverageDir, "--lcov"],
    cwd: projectRoot,
    stderr: "inherit",
    stdout: "piped",
  });
  const lcovResult = await lcovCmd.output();
  const lcov = new TextDecoder().decode(lcovResult.stdout);

  const { lineFailures, branchFailures } = findCoverageFailures(lcov);
  reportCoverageFailures(lineFailures, branchFailures);
};

/** Main: run the whole suite inside the harness, then enforce coverage */
const main = async (): Promise<void> => {
  const useCoverage = Deno.args.includes("--coverage");
  const exitCode = await withTestHarness(() =>
    runTests(["test/"], useCoverage),
  );

  if (exitCode !== 0) Deno.exit(exitCode);
  if (useCoverage) await checkCoverage();
  Deno.exit(0);
};

main();
