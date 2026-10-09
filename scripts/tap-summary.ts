/** The run summary's printing half: pure data in, console lines out. The
 * TAP reporter produces a `CompactTapSummary`; this module decides what a
 * person reads from a pass, a failure, or a silent exit. Kept apart from
 * the reporter so tests can pin the wording without a TAP stream. */

import { stripAnsi } from "./ansi.ts";

export type Location = {
  file: string;
  line?: number | undefined;
  column?: number | undefined;
};

export type CompactFailure = {
  name: string;
  message: string;
  location?: Location | undefined;
};

export type CompactTapSummary = {
  passed: number;
  failed: number;
  failures: CompactFailure[];
  sawTap: boolean;
  /** Parent results the reporter deliberately dropped because a child step
   * failure already carries the real diagnostic. */
  suppressedResults: number;
  /** The pre-run estimate from the test files' declarations, before any
   * growth the progress bar applied. 0 when the run gave no estimate. */
  fileEstimate: number;
  /** The name of the last result line the output carried. */
  lastResultName?: string | undefined;
  /** Stdout lines the TAP stream carried beside the results — the only place
   * a dying child's own error text can appear. */
  droppedLines: string[];
};

export const formatLocation = (location?: Location): string =>
  location
    ? `${location.file}${location.line ? `:${location.line}` : ""}${
        location.column ? `:${location.column}` : ""
      }`
    : "unknown location";

/** Strip the escape sequences, then keep every line Deno's own failure line
 *  does not already cover. */
const usefulStderr = (stderr: string): string =>
  stripAnsi(stderr)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "error: Test failed")
    .join("\n")
    .trim();

/** The test files deno's JUnit report marks with error entries. Deno's TAP
 * reporter drops the text of an uncaught error, but its JUnit report still
 * names the file it aborted, so the summary can point at the entry that was
 * running. */
export const junitErrorFiles = (junit: string): string[] => {
  const names = new Set<string>();
  const suite = /<testsuite\b[^>]*>/g;
  for (const tag of junit.matchAll(suite)) {
    const name = tag[0].match(/\bname="([^"]+)"/)?.[1];
    const errors = tag[0].match(/\berrors="([1-9]\d*)"/)?.[1];
    if (name && errors) names.add(name);
  }
  return [...names];
};

const describeStatus = (status: {
  code: number;
  signal?: string | null;
}): string =>
  status.signal
    ? `deno exited with code ${status.code}, killed by ${status.signal}`
    : `deno exited with code ${status.code}`;

/** The facts about a run that exited non-zero without a failed test: the
 * exit code and signal, the files deno's JUnit report blames, the stdout
 * lines the TAP results carried, and the last result shown. The block reads
 * the child's exit status, the JUnit-blamed files, and the filtered stderr. */
type ExitFacts = {
  summary: CompactTapSummary;
  status: { code: number; signal?: string | null };
  junitErrorFiles: string[];
  extra: string;
};

/** The files deno's JUnit report blames for uncaught errors — the closest
 * marker for a worker death and the failing run's own evidence. */
const printJunitErrorFiles = (junitErrorFiles: string[]): void => {
  if (junitErrorFiles.length === 0) return;
  console.error(
    "\ndeno's JUnit report marks these files with uncaught errors:",
  );
  for (const file of junitErrorFiles) console.error(`  ${file}`);
};

/** The stdout lines deno printed beside the TAP results — a worker or
 * module that aborted prints its only cause there. */
const printRetainedStdout = (droppedLines: readonly string[]): void => {
  if (droppedLines.length === 0) return;
  console.error("\nStdout lines deno printed beside the TAP results:");
  for (const line of droppedLines) console.error(line);
};

const printNoFailedTestFacts = ({
  summary,
  status,
  junitErrorFiles,
  extra,
}: ExitFacts): void => {
  console.error(describeStatus(status));
  printJunitErrorFiles(junitErrorFiles);
  if (
    extra === "" &&
    summary.droppedLines.length === 0 &&
    junitErrorFiles.length === 0
  ) {
    console.error("\ndeno printed no cause for this exit on either stream.");
  }
  const last =
    summary.lastResultName === undefined ? "(none)" : summary.lastResultName;
  console.error(`The last result shown was: ${last}`);
};

const printFailures = (summary: CompactTapSummary): void => {
  if (summary.failures.length === 0) return;
  console.error("\nFailed tests:");
  for (const failure of summary.failures) {
    console.error(`  ${formatLocation(failure.location)} - ${failure.name}`);
  }
};

export const printCompactSummary = (
  summary: CompactTapSummary,
  status: { code: number; signal?: string | null },
  stderrText: string,
  junitErrorFiles: string[] = [],
): void => {
  const extra = usefulStderr(stderrText);
  // The shortfall counts results that never arrived. A dropped parent
  // summary did arrive — a child step failure already carries the real
  // diagnostic — so it is subtracted like any other reported result.
  const missing =
    summary.fileEstimate -
    summary.passed -
    summary.failed -
    summary.suppressedResults;

  // The declaration count runs both sides of the real result count (it reads
  // fixture strings as declarations and misses loop-generated tests), so it
  // cannot prove a loss on a run the test runner itself called successful.
  if (summary.failed === 0 && status.code === 0) {
    console.log(`\nPASS ${summary.passed} passed`);
    return;
  }

  console.error(`\nFAILED ${summary.passed} passed, ${summary.failed} failed`);

  // A worker or module that aborted beside counted failures prints its only
  // cause as plain stdout, so the retained lines carry evidence on every
  // failing run, not only when no test failure was counted.
  printRetainedStdout(summary.droppedLines);

  if (summary.failed === 0) {
    printNoFailedTestFacts({ extra, junitErrorFiles, status, summary });
  }

  if (missing > 0 && !(summary.failed === 0 && extra !== "")) {
    console.error(
      `The declaration estimate is ${missing} above the results the output reported.`,
    );
  }

  if (summary.failed > 0) printJunitErrorFiles(junitErrorFiles);

  printFailures(summary);

  // Always surface stderr on a failing run: an uncaught error in a test
  // module (which aborts that module's remaining tests) is only reported
  // here, even when unrelated test failures were also counted.
  if (extra) {
    console.error("\nDeno output:");
    console.error(extra);
  }
};
