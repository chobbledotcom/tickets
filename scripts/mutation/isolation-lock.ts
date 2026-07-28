/**
 * The lock each mutation run holds while it owns its folder.
 *
 * The locking itself lives in #scripts/lock-file.ts, which every lock in the
 * repo goes through. This file only says where a run's lock is, and adds the
 * one thing runs need that other locks do not: asking whether somebody else is
 * holding one, without waiting to find out.
 */

import { withFileLock, withFileLockOrNull } from "#scripts/lock-file.ts";
import { statOrNull } from "#scripts/not-found.ts";
import { denoExitCode } from "./child-process.ts";
import {
  copyBackLockPath,
  type MutationRunRecord,
  runLockPath,
} from "./isolation-state.ts";

const LOCK_HELD_EXIT_CODE = 124;
const LOCK_FREE_EXIT_CODE = 0;

const LOCK_PROBE_SCRIPT = `
const [path, timeoutText] = Deno.args;
const timeout = setTimeout(
  () => Deno.exit(${LOCK_HELD_EXIT_CODE}),
  Number(timeoutText),
);
const opened = await Deno.open(path, { read: true, write: true }).catch((why) => why);
// A lock file that has gone is nobody holding one — a clear-up can take the
// folder away between being asked and being looked at.
if (opened instanceof Deno.errors.NotFound) {
  clearTimeout(timeout);
  Deno.exit(${LOCK_FREE_EXIT_CODE});
}
if (!(opened instanceof Deno.FsFile)) {
  clearTimeout(timeout);
  Deno.exit(2);
}
const file = opened;
try {
  await file.lock(true);
  await file.unlock();
  clearTimeout(timeout);
  file.close();
  Deno.exit(${LOCK_FREE_EXIT_CODE});
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
  // No lock file means no run holding one.
  if ((await statOrNull(path)) === null) return false;
  const stopped = await lockProbeExitCode(path, timeoutMs);
  if (stopped === LOCK_HELD_EXIT_CODE) return true;
  if (stopped === LOCK_FREE_EXIT_CODE) return false;
  throw new Error(
    `Could not tell whether the lock at ${path} is held: the check stopped with code ${stopped}`,
  );
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

/** Holds the lock named by `Key` while the body runs. */
export type LockHolder<Key> = <Result>(
  key: Key,
  run: () => Promise<Result>,
) => Promise<Result>;

/** A lock named by where it lives: say how to find it, get its holder. */
const lockHolder =
  <Key>(pathOf: (key: Key) => string): LockHolder<Key> =>
  (key, run) =>
    withFileLock(pathOf(key), run);

/** Hold a run's own lock, for as long as the run needs it. */
export const withMutationRunLock: LockHolder<string> = lockHolder(
  (runRootPath: string) => runLockPath({ root: runRootPath }),
);

/**
 * Hold the checkout's copy-back lock. Every run brings its kept files back
 * through this one lock, so two runs finishing together cannot both read the
 * checkout, agree it is unchanged, and then write over each other.
 */
export const withCopyBackLock: LockHolder<string> =
  lockHolder(copyBackLockPath);
