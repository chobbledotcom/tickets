/**
 * The shared failure boundary for sandbox harness entrypoints. A failed run
 * — a leg the provider refused, missing credentials, a broken build, a
 * runner crash — must say so, ping ntfy, and set the exit status.
 */

import { fail } from "./log.ts";

/** Report a failed run: the message, the ntfy ping, and exit status 1. */
export const failRun = async (
  message: string,
  notify: () => Promise<void>,
): Promise<void> => {
  fail(message);
  await notify().catch(() => {});
  process.exitCode = 1;
};

/** Run a harness main; a crash reports its stack as the failed run. */
export const runHarness = (
  main: () => Promise<void>,
  notify: () => Promise<void>,
): void => {
  main().catch((err) =>
    failRun(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
      notify,
    ),
  );
};
