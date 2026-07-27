/**
 * The lock each mutation run holds while it owns its folder.
 *
 * The locking itself lives in #scripts/lock-file.ts, which every lock in the
 * repo goes through. This file only says where a run's lock is, and adds the
 * one thing runs need that other locks do not: asking whether somebody else is
 * holding one, without waiting to find out.
 */

import {
  openLockFileOrNull,
  withFileLock,
  withFileLockOrNull,
} from "#scripts/lock-file.ts";
import { denoExitCode } from "./child-process.ts";
import { type MutationRunRecord, runLockPath } from "./isolation-state.ts";

const LOCK_HELD_EXIT_CODE = 124;

const LOCK_PROBE_SCRIPT = `
const [path, timeoutText] = Deno.args;
const timeout = setTimeout(
  () => Deno.exit(${LOCK_HELD_EXIT_CODE}),
  Number(timeoutText),
);
const file = await Deno.open(path, { read: true, write: true }).catch(() => null);
if (file === null) {
  clearTimeout(timeout);
  Deno.exit(2);
}
try {
  await file.lock(true);
  await file.unlock();
  clearTimeout(timeout);
  file.close();
  Deno.exit(0);
} catch {
  clearTimeout(timeout);
  file.close();
  Deno.exit(2);
}
`;

const lockProbeExitCode = (path: string, timeoutMs: number): Promise<number> =>
  denoExitCode(["eval", LOCK_PROBE_SCRIPT, "--", path, String(timeoutMs)], {
    stderr: "null",
    stdout: "null",
  });

/**
 * Is somebody holding this run's lock? Asked in a child process, because a lock
 * this process already holds would look free to itself.
 */
export const runLockIsHeld = async (
  record: Pick<MutationRunRecord, "root">,
  timeoutMs = 50,
): Promise<boolean> => {
  const path = runLockPath(record);
  // No folder means no run to hold it.
  const file = await openLockFileOrNull(path);
  if (file === null) return false;
  file.close();
  return (await lockProbeExitCode(path, timeoutMs)) === LOCK_HELD_EXIT_CODE;
};

/**
 * Hold a run's lock while `run` works, but only if it is free within
 * `timeoutMs`; otherwise give up and answer `null`. Clearing up must never
 * queue behind a run that holds its folder for an hour.
 */
export const withRunLockOrNull = <Result>(
  record: Pick<MutationRunRecord, "root">,
  run: () => Promise<Result>,
  timeoutMs = 250,
): Promise<Result | null> =>
  withFileLockOrNull(runLockPath(record), timeoutMs, run);

/** Hold a run's own lock, for as long as the run needs it. */
export const withMutationRunLock = <Result>(
  runRootPath: string,
  run: () => Promise<Result>,
): Promise<Result> => withFileLock(runLockPath({ root: runRootPath }), run);
