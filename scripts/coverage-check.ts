/**
 * Pure lcov → coverage-gap logic shared by the full coverage gate
 * (scripts/run-tests.ts) and the scoped runner (scripts/cov-files.ts).
 */

import { requireValue } from "#shared/required-value.ts";
import { projectRoot } from "./project-root.ts";

export type CoverageMetricFailure = {
  covered: number;
  total: number;
  uncovered: number[];
};

export type CoverageFailure = {
  file: string;
  sourceFile: string;
  lines?: CoverageMetricFailure;
  branches?: CoverageMetricFailure;
};

const SNIPPET_CONTEXT_LINES = 1;
const MAX_SNIPPET_LINES_PER_FILE = 18;
const MAX_GITHUB_ANNOTATIONS = 100;

/** Line numbers captured by group 1 of every match of `pattern` in `record`.
 * Every caller's pattern has a `(\d+)` group 1, so each match always carries
 * one. */
const capturedLineNumbers = (record: string, pattern: RegExp): number[] =>
  Array.from(record.matchAll(pattern), (match) =>
    Number.parseInt(
      requireValue(match[1], "Coverage pattern did not capture a line number"),
      10,
    ),
  );

/** Extract uncovered line numbers from DA: entries in an lcov record */
const extractUncoveredLines = (record: string): number[] =>
  capturedLineNumbers(record, /^DA:(\d+),0$/gm);

/** Extract uncovered branch line numbers from BRDA: entries, deduped */
const extractUncoveredBranchLines = (record: string): number[] => [
  ...new Set(capturedLineNumbers(record, /^BRDA:(\d+),\d+,\d+,(-|0)$/gm)),
];

const uniqueSorted = (nums: number[]): number[] =>
  [...new Set(nums)].sort((a, b) => a - b);

const formatRanges = (nums: number[]): string => {
  const sorted = uniqueSorted(nums);
  if (sorted.length === 0) return "unknown";

  const ranges: string[] = [];
  let start = sorted[0]!;
  let end = start;
  const flushRange = (): void => {
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  };
  for (const line of sorted.slice(1)) {
    if (line === end + 1) {
      end = line;
      continue;
    }
    flushRange();
    start = line;
    end = line;
  }
  flushRange();
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
  if (!hitText || !foundText) return;
  const covered = Number.parseInt(hitText, 10);
  const total = Number.parseInt(foundText, 10);
  return covered < total ? { covered, total, uncovered } : undefined;
};

// Files excluded from coverage enforcement
const COVERAGE_EXCLUSIONS = [
  "scripts/compact-test-reporter.ts",
  "src/shared/db/migrations.ts",
  // Harness infrastructure: inside a harness run every isolate takes the
  // prebuilt-snapshot arm, and outside one only the build-it-here arm runs,
  // so no single coverage run can reach both. The round-trip behaviour is
  // unit-tested in test/test-utils/test-state.test.ts.
  "test/test-utils/test-state.ts",
  // Harness infrastructure, same shape as the line above: the harness has
  // already made the assets current before any test isolate starts, so inside
  // a coverage run only the "already up to date" arm can ever be taken —
  // rebuilding the shared assets mid-run to reach the other one would race
  // every isolate still loading them. What is left in the file is wiring: the
  // choice itself is buildOrReuseStaticAssets, and it and
  // staticAssetsAreUpToDate are both unit-tested, each arm, in
  // test/scripts/static-asset-cache.test.ts.
  "scripts/static-assets/prepare.ts",
  // The e2e-payments config snapshot reads env vars at module-load time. The
  // bool/num helpers and the forceTunnel/needsTunnel branches are exercised by
  // the live Cucumber free target run plus the direct secrets/config-log tests,
  // but coverage only sees the module-load path the test runner took —
  // not the alternative env states the harness boots in for each target.
  "e2e-payments/src/config.ts",
  // parseLiveTarget's throw path is tested in test/e2e-payments/parse-target, but
  // the test runner's group system may not pair it into the same isolate as the
  // coverage probe — the function is also covered by the live Cucumber run.
  "e2e-payments/src/targets.ts",
  // The live Cucumber harness: real app servers, tunnels, provider sandboxes
  // and Chromium sessions. Only the nightly workflow can execute these; the
  // step-coverage test imports the support modules (which pull these files
  // in), so a coverage run sees them loaded-but-untested. The pure helpers
  // with deterministic behaviour (cleanup, db-fault, refund-outcome) stay
  // under normal coverage and are directly tested under test/e2e-payments/.
  "e2e-payments/src/browser.ts",
  "e2e-payments/src/flow.ts",
  "e2e-payments/src/order-flow.ts",
  "e2e-payments/src/server.ts",
  "e2e-payments/src/tunnel.ts",
  "e2e-payments/src/util.ts",
  "e2e-payments/src/providers/card.ts",
  "e2e-payments/src/providers/shared.ts",
  "e2e-payments/src/providers/square.ts",
  "e2e-payments/src/providers/stripe.ts",
  "e2e-payments/src/providers/sumup.ts",
  "e2e-payments/src/providers/sumup-callback.ts",
  "e2e-payments/src/cucumber/support/hooks.ts",
  "e2e-payments/src/cucumber/support/journal.ts",
  "e2e-payments/src/cucumber/support/world.ts",
  "e2e-payments/src/cucumber/steps/booking.ts",
  "e2e-payments/src/cucumber/steps/pages.ts",
  "e2e-payments/src/cucumber/steps/setup.ts",
];

/** Extract source path info from an lcov record, or null if excluded. */
const extractRecordSource = (
  record: string,
): { file: string; sourceFile: string } | null => {
  const sourceFile = requireValue(
    record.match(/SF:(.*)/)?.[1],
    "lcov record without an SF: line",
  );
  const file = sourceFile.replace(`${projectRoot}/`, "");
  if (COVERAGE_EXCLUSIONS.some((exclusion) => file.includes(exclusion))) {
    return null;
  }
  return { file, sourceFile };
};

/** Check both line and branch coverage for a single lcov record */
const checkRecord = (record: string): CoverageFailure | undefined => {
  const source = extractRecordSource(record);
  if (!source) return;

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
  if (!lines && !branches) return;
  return {
    ...source,
    ...(branches ? { branches } : {}),
    ...(lines ? { lines } : {}),
  };
};

/** Parse lcov records and return coverage failures */
export const findCoverageFailures = (
  lcov: string,
): CoverageFailure[] | null => {
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

const sourceLineNumbersForSnippet = (
  failure: CoverageFailure,
  sourceLineCount: number,
): number[] => {
  const wanted = new Set<number>();
  for (const line of snippetLineNumbers(failure)) {
    const first = Math.max(1, line - SNIPPET_CONTEXT_LINES);
    const last = Math.min(sourceLineCount, line + SNIPPET_CONTEXT_LINES);
    for (let next = first; next <= last; next++) wanted.add(next);
  }
  return [...wanted].sort((a, b) => a - b);
};

const readSourceSnippet = async (
  failure: CoverageFailure,
): Promise<string[]> => {
  const text = await Deno.readTextFile(failure.sourceFile).catch(() => "");
  if (!text) return [];

  const sourceLines = text.split(/\r?\n/);
  const lines = sourceLineNumbersForSnippet(failure, sourceLines.length);
  const visible = lines.slice(0, MAX_SNIPPET_LINES_PER_FILE);
  const width = String(visible.at(-1) ?? 1).length;
  const snippets: string[] = [];
  let previous = 0;

  for (const line of visible) {
    if (previous > 0 && line > previous + 1) snippets.push("    ...");
    snippets.push(
      `    ${String(line).padStart(width, " ")} | ${sourceLines[line - 1]}`,
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
    const pushUncovered = (kind: string, lines: number[] | undefined): void => {
      for (const line of lines ?? []) {
        entries.push({
          file: failure.file,
          line,
          message: `${kind} coverage missing at ${failure.file}:${line}`,
        });
      }
    };
    pushUncovered("line", failure.lines?.uncovered);
    pushUncovered("branch", failure.branches?.uncovered);
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

export const printFailureSummary = async (
  failure: CoverageFailure,
): Promise<void> => {
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

/** Print the coverage gap report and return the exit code it deserves:
 * 0 when everything is covered, 1 when gaps exist or no data was found. */
export const printCoverageReport = async (
  failures: CoverageFailure[] | null,
): Promise<number> => {
  if (failures && failures.length === 0) {
    console.log("\nAll files have 100% line and branch coverage");
    return 0;
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
  return 1;
};
