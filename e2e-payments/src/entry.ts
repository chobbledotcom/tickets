/**
 * The shared failure boundary for sandbox harness entrypoints.
 *
 * A failed run — a leg the provider refused, a scenario that did not assert,
 * missing credentials, a broken build — must say so and set the exit status.
 * It notifies nobody: the red CI job is the report, and the failure text
 * carries no stack a bug catcher could group by.
 *
 * A crash is not a planned failure, so it also reports to the operator's
 * bug catcher with the exception itself.
 */

import { fail } from "./log.ts";

/** Report a failed run's message and set the failure exit status. */
export const failRun = async (message: string): Promise<void> => {
  fail(message);
  process.exitCode = 1;
};

/** Run a harness main; a crash reports to the bug catcher and fails the run. */
export const runHarness = (
  main: () => Promise<void>,
  reportCrash: (error: unknown) => Promise<void>,
): Promise<void> =>
  main().catch(async (err) => {
    await reportCrash(err).catch(() => {
      // The run already failed; a failed report must not mask the crash.
    });
    await failRun(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  });
