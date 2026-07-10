#!/usr/bin/env -S deno run --allow-all
/**
 * Slow-test finder: runs the full suite (via the shared test harness) and
 * treats the 500ms slow-test threshold as a hard failure instead of a quiet
 * end-of-run warning, so a slow test surfaces as a crashing, slowest-first list
 * rather than a notice you might miss. Exits 1 when any test is too slow; 0
 * when none are. Coverage is skipped — it isn't needed to find slow tests and
 * only slows the run.
 */

import {
  JUNIT_PATH,
  readSlowTestsReport,
  SLOW_TEST_THRESHOLD_MS,
} from "./test-durations.ts";
import { runTests, withTestHarness } from "./test-harness.ts";

/** Main: run the suite, then fail if any test exceeded the slow-test threshold. */
const main = async (): Promise<void> => {
  // Remove any stale JUnit file so a killed prior run can't surface its
  // timings; `deno test --junit-path` rewrites it on a completed run.
  await Deno.remove(JUNIT_PATH).catch(() => {});
  const exitCode = await withTestHarness(() =>
    runTests(["test/"], false, JUNIT_PATH),
  );

  // Propagate a suite failure before judging timings: a failed run may have
  // written an incomplete JUnit file, whose timings would be misleading.
  if (exitCode !== 0) Deno.exit(exitCode);

  const report = await readSlowTestsReport();
  if (report) {
    console.error(report);
    console.error(
      `\nFailing: tests above exceed the ${SLOW_TEST_THRESHOLD_MS}ms slow-test threshold.`,
    );
    Deno.exit(1);
  }

  console.log(`No tests exceeded the ${SLOW_TEST_THRESHOLD_MS}ms threshold.`);
  Deno.exit(0);
};

main();
