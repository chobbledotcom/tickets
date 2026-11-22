/**
 * The unmutated baseline: time every selected test file, then check that each
 * plan's grouped runs pass together.
 *
 * A test that fails on the unmutated code would "kill" every mutant and prove
 * nothing. So the run stops here, before any mutant is tested.
 */

import type { TestRunConfig, TestRunResult } from "./execution.ts";
import { inParallel } from "./parallel.ts";
import { planFor, runName, type TimedTest, timeLimit } from "./plan.ts";

/** How long one file may take in the baseline. A file that needs longer on its
 *  own is stuck, not slow. */
export const BASELINE_FILE_LIMIT_MS = 600_000;

/** Run one test batch. The caller supplies the signal the run can abort. */
export interface BaselineDeps {
  runTest(config: TestRunConfig, signal: AbortSignal): Promise<TestRunResult>;
}

export interface BaselineOptions {
  batchJobs: number;
  env: Record<string, string>;
  signal: AbortSignal;
}

/** Why the baseline did not pass. `output` is the child's own text. */
export interface BaselineFailure {
  message: string;
  output?: string;
}

/** Every test file with the time it took on its own. */
export interface TimedBaseline {
  durationMs: number;
  timings: TimedTest[];
}

export type BaselineMeasurement =
  | { failure: BaselineFailure; status: "failed" }
  | { result: TimedBaseline; status: "passed" };

/** Why a test run did not pass, or null when it did. */
const failureOf = (
  result: TestRunResult,
  what: string,
): BaselineFailure | null => {
  if (result.outcome === "passed") return null;
  if (result.frozen !== undefined) {
    return {
      message: `${what} ran past its ${result.frozen.limitMs}ms limit.`,
    };
  }
  if (result.failure !== undefined) {
    return { message: `${what} failed.`, output: result.failure.output };
  }
  return { message: `${what} was cancelled before it passed.` };
};

/**
 * Run every file on the unchanged code, each in a fresh `deno test` process,
 * and time each. `batchJobs` files run at once. One failed file stops the run
 * with its own output.
 */
export const timeTestFiles = async (
  files: readonly string[],
  options: BaselineOptions,
  deps: BaselineDeps,
): Promise<BaselineMeasurement> => {
  const startedAt = performance.now();
  const jobs = Math.min(
    Math.max(1, options.batchJobs),
    Math.max(1, files.length),
  );
  const outcomes = await inParallel(
    files,
    Array.from({ length: jobs }, (_, index) => index),
    async (file) => {
      const fileStartedAt = performance.now();
      const result = await deps.runTest(
        {
          batchJobs: 1,
          env: options.env,
          limitMs: BASELINE_FILE_LIMIT_MS,
          testFiles: [file],
        },
        options.signal,
      );
      return {
        failure: failureOf(result, `Unmutated ${file}`),
        file,
        ms: performance.now() - fileStartedAt,
      };
    },
  );
  const failed = outcomes.find((outcome) => outcome.failure !== null);
  if (failed?.failure) return { failure: failed.failure, status: "failed" };
  return {
    result: {
      durationMs: performance.now() - startedAt,
      timings: outcomes.map(({ file, ms }) => ({ file, ms })),
    },
    status: "passed",
  };
};

/**
 * Check each plan's grouped runs on the unchanged code. A file passed on its
 * own; this proves the fast files also pass together, so a later failure in
 * that run can only come from the mutant.
 */
export const verifyGroupedRuns = async (
  testSets: readonly (readonly string[])[],
  timings: readonly TimedTest[],
  options: BaselineOptions,
  deps: BaselineDeps,
): Promise<BaselineFailure[]> => {
  const checked = new Set<string>();
  const failures: BaselineFailure[] = [];
  for (const testFiles of testSets) {
    for (const run of planFor(testFiles, timings)) {
      if (run.files.length < 2) continue;
      const key = [...run.files].sort().join("\n");
      if (checked.has(key)) continue;
      checked.add(key);
      const result = await deps.runTest(
        {
          batchJobs: options.batchJobs,
          env: options.env,
          limitMs: timeLimit(run),
          testFiles: [...run.files],
        },
        options.signal,
      );
      const failure = failureOf(
        result,
        `Unmutated run of ${runName(run.files)} together`,
      );
      if (failure !== null) failures.push(failure);
    }
  }
  return failures;
};
