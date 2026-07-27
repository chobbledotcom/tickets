/**
 * The lock each mutation run holds while it owns its folder.
 */

import { openLockFile } from "#scripts/lock-file.ts";
import { nullIfNotFound, statOrNull } from "#scripts/not-found.ts";
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

export const runLockIsHeld = async (
  record: Pick<MutationRunRecord, "root">,
  timeoutMs = 50,
): Promise<boolean> => {
  const path = runLockPath(record);
  // No folder means no run to hold it. A disk that cannot be opened at all is
  // not the same answer, so it throws rather than reading as "nobody's".
  const file = await nullIfNotFound(openLockFile(path));
  if (file === null) return false;
  file.close();
  return (await lockProbeExitCode(path, timeoutMs)) === LOCK_HELD_EXIT_CODE;
};

/** Is the open lock file still the one sitting at the run's lock path? */
const stillTheLockFile = async (
  file: Deno.FsFile,
  record: Pick<MutationRunRecord, "root">,
): Promise<boolean> => {
  const atPath = await statOrNull(runLockPath(record));
  if (atPath === null) return false;
  const held = await file.stat();
  // Some filesystems keep no inode numbers; there, take the file at its word.
  return held.ino === null || atPath.ino === null || held.ino === atPath.ino;
};

/** A wait for a lock: `true` once it is held, `false` if it gave up first. */
type WaitForLock = (file: Deno.FsFile) => Promise<boolean>;

const waitHoweverLong: WaitForLock = (file) => file.lock(true).then(() => true);

/** Wait for the lock, but only for `timeoutMs`. */
const waitUpTo =
  (timeoutMs: number): WaitForLock =>
  async (file) => {
    let waited = 0;
    const gaveUp = new Promise<false>((resolve) => {
      waited = setTimeout(() => resolve(false), timeoutMs);
      Deno.unrefTimer(waited);
    });
    const held = await Promise.race([waitHoweverLong(file), gaveUp]);
    clearTimeout(waited);
    return held;
  };

/**
 * Run `work` while holding `file` as the run's lock. `null` means the lock was
 * never taken, or that the file it took is no longer the one at the path: a
 * clear-up can remove the folder while this waits, and a lock on a file nothing
 * points at keeps nobody out.
 */
const underLockFile = async <Result>(
  file: Deno.FsFile,
  record: Pick<MutationRunRecord, "root">,
  waitForLock: WaitForLock,
  work: () => Promise<Result>,
): Promise<{ value: Result } | null> => {
  if (!(await waitForLock(file))) {
    // Closing hands back anything the abandoned wait is later granted.
    file.close();
    return null;
  }
  try {
    return (await stillTheLockFile(file, record))
      ? { value: await work() }
      : null;
  } finally {
    await file.unlock();
    file.close();
  }
};

/**
 * Hold a run's lock while `run` works, but only if it is free within
 * `timeoutMs`; otherwise give up and answer `null`. Clearing up must never
 * queue behind a run that holds its folder for an hour.
 */
export const withRunLockOrNull = async <Result>(
  record: Pick<MutationRunRecord, "root">,
  run: () => Promise<Result>,
  timeoutMs = 250,
): Promise<Result | null> => {
  // A folder that has gone is nobody's to take: another clear-up got there
  // first. Any other failure to open means a disk we must not guess about.
  const file = await nullIfNotFound(openLockFile(runLockPath(record)));
  if (file === null) return null;
  const held = await underLockFile(file, record, waitUpTo(timeoutMs), run);
  return held === null ? null : held.value;
};

/**
 * Hold a run's own lock, making its folder first so there is one to lock. A
 * clear-up can take the folder away while this waits, so it makes the folder
 * and takes the lock again until the one it holds is the file at the path.
 */
export const withMutationRunLock = async <Result>(
  runRootPath: string,
  run: () => Promise<Result>,
): Promise<Result> => {
  const record = { root: runRootPath };
  const oneGo = async () => {
    await Deno.mkdir(runRootPath, { recursive: true });
    // The folder can go between making it and opening the lock in it, which is
    // another go rather than a failure. Any other open error is a real one.
    const file = await nullIfNotFound(openLockFile(runLockPath(record)));
    return file === null
      ? null
      : await underLockFile(file, record, waitHoweverLong, run);
  };
  let held = await oneGo();
  while (held === null) held = await oneGo();
  return held.value;
};
