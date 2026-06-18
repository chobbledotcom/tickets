#!/usr/bin/env -S deno run --allow-all
/**
 * Full test runner: builds static assets and starts stripe-mock (via the
 * shared test harness), runs the whole suite, and—with --coverage—enforces
 * 100% line and branch coverage. Generated static assets are cleaned up by the
 * harness once the run completes.
 */

import { join } from "node:path";
import { projectRoot, runTests, withTestHarness } from "./test-harness.ts";

type CoverageMetricFailure = {
  covered: number;
  total: number;
  uncovered: number[];
};

type CoverageFailure = {
  file: string;
  sourceFile: string;
  lines?: CoverageMetricFailure;
  branches?: CoverageMetricFailure;
};

const SNIPPET_CONTEXT_LINES = 1;
const MAX_SNIPPET_LINES_PER_FILE = 18;
const MAX_GITHUB_ANNOTATIONS = 100;

/** Extract uncovered line numbers from DA: entries in an lcov record */
const extractUncoveredLines = (record: string): number[] => {
  const matches = record.matchAll(/^DA:(\d+),0$/gm);
  const lines: number[] = [];
  for (const m of matches) {
    const line = m[1];
    if (line) lines.push(Number.parseInt(line, 10));
  }
  return lines;
};

/** Extract uncovered branch line numbers from BRDA: entries, deduped */
const extractUncoveredBranchLines = (record: string): number[] => {
  const matches = record.matchAll(/^BRDA:(\d+),\d+,\d+,(-|0)$/gm);
  const seen = new Set<number>();
  const lines: number[] = [];
  for (const m of matches) {
    const lineText = m[1];
    if (!lineText) continue;
    const line = Number.parseInt(lineText, 10);
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
};

const uniqueSorted = (nums: number[]): number[] =>
  [...new Set(nums)].sort((a, b) => a - b);

const formatRanges = (nums: number[]): string => {
  const sorted = uniqueSorted(nums);
  if (sorted.length === 0) return "unknown";

  const ranges: string[] = [];
  let start = sorted[0]!;
  let end = start;
  for (const line of sorted.slice(1)) {
    if (line === end + 1) {
      end = line;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = line;
    end = line;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(", ");
};

const escapeAnnotationValue = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** Check a coverage metric (lines or branches) in an lcov record */
const metricFailure = (
  record: string,
  hitKey: string,
  foundKey: string,
  uncovered: number[],
): CoverageMetricFailure | undefined => {
  const hitMatch = record.match(new RegExp(`${hitKey}:(\\d+)`));
  const foundMatch = record.match(new RegExp(`${foundKey}:(\\d+)`));
  const hitText = hitMatch?.[1];
  const foundText = foundMatch?.[1];
  if (!hitText || !foundText) return undefined;
  const covered = Number.parseInt(hitText, 10);
  const total = Number.parseInt(foundText, 10);
  return covered < total ? { covered, total, uncovered } : undefined;
};

// Files excluded from coverage enforcement
const COVERAGE_EXCLUSIONS = [
  "scripts/compact-test-reporter.ts",
  "src/shared/db/migrations.ts",
  "test/test-utils/",
];

/** Extract source path info from an lcov record, or null if excluded. */
const extractRecordSource = (
  record: string,
): { file: string; sourceFile: string } | null => {
  const sfMatch = record.match(/SF:(.*)/);
  const sourceFile = sfMatch?.[1];
  if (!sourceFile) return null;
  const file = sourceFile.replace(`${projectRoot}/`, "");
  if (COVERAGE_EXCLUSIONS.some((exclusion) => file.includes(exclusion))) {
    return null;
  }
  return { file, sourceFile };
};

/** Check both line and branch coverage for a single lcov record */
const checkRecord = (record: string): CoverageFailure | undefined => {
  const source = extractRecordSource(record);
  if (!source) return undefined;

  const lines = metricFailure(
    record,
    "LH",
    "LF",
    extractUncoveredLines(record),
  );
  const branches = metricFailure(
    record,
    "BRH",
    "BRF",
    extractUncoveredBranchLines(record),
  );
  return lines || branches ? { ...source, branches, lines } : undefined;
};

/** Parse lcov records and return coverage failures */
const findCoverageFailures = (lcov: string): CoverageFailure[] | null => {
  const records = lcov.split("end_of_record").filter((r) => r.includes("SF:"));
  if (records.length === 0) return null;

  const failures: CoverageFailure[] = [];
  for (const record of records) {
    const failure = checkRecord(record);
    if (failure) failures.push(failure);
  }
  return failures;
};

const snippetLineNumbers = (failure: CoverageFailure): number[] =>
  uniqueSorted([
    ...(failure.lines?.uncovered ?? []),
    ...(failure.branches?.uncovered ?? []),
  ]);

const readSourceSnippet = async (
  failure: CoverageFailure,
): Promise<string[]> => {
  const text = await Deno.readTextFile(failure.sourceFile).catch(() => "");
  if (!text) return [];

  const sourceLines = text.split(/\r?\n/);
  const wanted = new Set<number>();
  for (const line of snippetLineNumbers(failure)) {
    for (
      let next = line - SNIPPET_CONTEXT_LINES;
      next <= line + SNIPPET_CONTEXT_LINES;
      next++
    ) {
      if (next >= 1 && next <= sourceLines.length) wanted.add(next);
    }
  }

  const lines = [...wanted].sort((a, b) => a - b);
  const visible = lines.slice(0, MAX_SNIPPET_LINES_PER_FILE);
  const width = String(visible.at(-1) ?? 1).length;
  const snippets: string[] = [];
  let previous = 0;

  for (const line of visible) {
    if (previous > 0 && line > previous + 1) snippets.push("    ...");
    snippets.push(
      `    ${String(line).padStart(width, " ")} | ${sourceLines[line - 1] ?? ""}`,
    );
    previous = line;
  }

  if (lines.length > visible.length) {
    snippets.push(`    ... ${lines.length - visible.length} more source lines`);
  }
  return snippets;
};

const githubAnnotationEntries = (
  failures: CoverageFailure[],
): { file: string; line: number; message: string }[] => {
  const entries: { file: string; line: number; message: string }[] = [];
  for (const failure of failures) {
    for (const line of failure.lines?.uncovered ?? []) {
      entries.push({
        file: failure.file,
        line,
        message: `line coverage missing at ${failure.file}:${line}`,
      });
    }
    for (const line of failure.branches?.uncovered ?? []) {
      entries.push({
        file: failure.file,
        line,
        message: `branch coverage missing at ${failure.file}:${line}`,
      });
    }
  }
  return entries;
};

const emitGithubAnnotations = (failures: CoverageFailure[]): void => {
  if (!Deno.env.get("GITHUB_ACTIONS")) return;

  const entries = githubAnnotationEntries(failures);
  for (const entry of entries.slice(0, MAX_GITHUB_ANNOTATIONS)) {
    console.error(
      `::error file=${escapeAnnotationValue(entry.file)},line=${entry.line}::${escapeAnnotationValue(entry.message)}`,
    );
  }

  if (entries.length > MAX_GITHUB_ANNOTATIONS) {
    console.error(
      `::error::${entries.length - MAX_GITHUB_ANNOTATIONS} additional coverage annotations omitted; see grouped coverage report below`,
    );
  }
};

const printFailureSummary = async (failure: CoverageFailure): Promise<void> => {
  console.error(`\n${failure.file}`);
  if (failure.lines) {
    console.error(
      `  lines: ${failure.lines.covered}/${failure.lines.total} covered; missing ${formatRanges(
        failure.lines.uncovered,
      )}`,
    );
  }
  if (failure.branches) {
    console.error(
      `  branches: ${failure.branches.covered}/${failure.branches.total} covered; missing ${formatRanges(
        failure.branches.uncovered,
      )}`,
    );
  }

  const snippets = await readSourceSnippet(failure);
  if (snippets.length > 0) {
    console.error("  snippets:");
    for (const line of snippets) console.error(line);
  }
};

/** Report coverage failures and exit if any */
const reportCoverageFailures = async (
  failures: CoverageFailure[] | null,
): Promise<void> => {
  if (failures && failures.length === 0) {
    console.log("\nAll files have 100% line and branch coverage");
    return;
  }

  console.error("\nCoverage failed");
  if (!failures) {
    console.error("\nNo coverage data found");
  } else {
    emitGithubAnnotations(failures);
    for (const failure of failures) await printFailureSummary(failure);
  }

  console.error("\nTest quality rules:");
  console.error("  - 100% line coverage is required");
  console.error("  - 100% branch coverage is required");
  console.error("  - Test outcomes not implementations");
  console.error("  - Test-only exports are forbidden");
  console.error("  - Tautological tests are forbidden");
  console.error("\nRerun: deno task test:coverage");
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
    stdout: Deno.env.get("CI") ? "null" : "inherit",
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

  await reportCoverageFailures(findCoverageFailures(lcov));
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
