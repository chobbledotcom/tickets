import {
  type CompactFailure,
  type CompactTapSummary,
  type JunitErroredTest,
  printCompactSummary,
} from "#scripts/tap-summary.ts";
import { capturingConsole } from "#test-utils/captured-console.ts";

export const summary = (
  over: Partial<CompactTapSummary> = {},
): CompactTapSummary => ({
  droppedLines: [],
  failed: 0,
  failures: [],
  fileEstimate: 0,
  passed: 3,
  sawTap: true,
  skipped: 0,
  suppressedResults: 0,
  ...over,
});

/** Capture what the summary printed to each console stream. */
export const printed = (
  result: CompactTapSummary,
  status: number | { code: number; signal?: string | null },
  stderrText: string,
  junitErrorFiles: string[] = [],
  junitErrored: JunitErroredTest[] = [],
): Promise<{ errors: string[]; logs: string[] }> =>
  capturingConsole(() =>
    printCompactSummary(
      result,
      typeof status === "number" ? { code: status, signal: null } : status,
      stderrText,
      junitErrorFiles,
      junitErrored,
    ),
  );

/** Prints the hosted shape: twelve green members, one Turso failure, and
 * the errored JUnit record the runner wrote for it. */
export const printedCancellation = (
  failure: CompactFailure,
  errored: JunitErroredTest[],
): Promise<{ errors: string[]; logs: string[] }> =>
  printed(
    summary({
      failed: 1,
      failures: [failure],
      fileEstimate: 13,
      passed: 12,
    }),
    1,
    "",
    [],
    errored,
  );

export const TURSO_RECORD: JunitErroredTest = {
  column: 1,
  file: "./test/scripts/turso-migration-file.test.ts",
  line: 121,
  message: "Cancelled",
  name: "Turso migration file",
};
