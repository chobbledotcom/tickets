/**
 * Advisory file locks: one holder at a time, across processes.
 *
 * A lock is only worth something while the file it holds is the file at its
 * path. Anything that clears folders away can unlink a lock somebody is queued
 * on, and that waiter is then handed a file nothing points at, which keeps
 * nobody out. So every lock here is checked once it is taken.
 */

import { dirname } from "@std/path";
import { holdLockOrNull } from "#scripts/held-lock-process.ts";
import { nullIfNotFound, statOrNull } from "#scripts/not-found.ts";

/** Open (creating if needed) a file to hold an advisory lock. */
const openLockFile = (path: string): Promise<Deno.FsFile> =>
  Deno.open(path, { create: true, read: true, write: true });

/**
 * The lock file at `path`, or `null` when there is no folder to make it in.
 * A disk that cannot be opened at all is a different answer, and throws.
 */
export const openLockFileOrNull = (path: string): Promise<Deno.FsFile | null> =>
  nullIfNotFound(openLockFile(path));

/** Is the open file the one sitting at `path`? */
const heldLockIsAtPath = async (
  file: Deno.FsFile,
  path: string,
): Promise<boolean> => {
  const atPath = await statOrNull(path);
  if (atPath === null) return false;
  const held = await file.stat();
  // Some filesystems keep no file numbers; there, take the lock at its word.
  return held.ino === null || atPath.ino === null || held.ino === atPath.ino;
};

/** A wait for a lock: `true` once it is held, `false` if it gave up first. */
type WaitForLock = (file: Deno.FsFile) => Promise<boolean>;

const waitHoweverLong: WaitForLock = (file) => file.lock(true).then(() => true);

/**
 * One go at holding the lock at `path` while `body` runs. `null` means the go
 * came to nothing: the file was not there, the wait gave up, or the lock it
 * ended up holding was no longer the file at the path.
 */
const oneGoAtLock = async <Result>(
  path: string,
  waitForLock: WaitForLock,
  body: () => Promise<Result>,
): Promise<{ value: Result } | null> => {
  const file = await openLockFileOrNull(path);
  if (file === null) return null;
  if (!(await waitForLock(file))) {
    // Closing hands back anything the abandoned wait is later granted.
    file.close();
    return null;
  }
  try {
    return (await heldLockIsAtPath(file, path))
      ? { value: await body() }
      : null;
  } finally {
    await file.unlock();
    file.close();
  }
};

/**
 * Hold the lock at `path` while `body` runs, waiting as long as it takes and
 * making the folder the lock lives in. A clear-up can take that folder away
 * mid-wait, so it keeps going until the lock it holds is the file at the path.
 */
export const withFileLock = async <Result>(
  path: string,
  body: () => Promise<Result>,
): Promise<Result> => {
  const oneGo = async () => {
    await Deno.mkdir(dirname(path), { recursive: true });
    return await oneGoAtLock(path, waitHoweverLong, body);
  };
  let held = await oneGo();
  while (held === null) held = await oneGo();
  return held.value;
};

/**
 * Hold the lock at `path` while `body` runs, but only if it comes free within
 * `timeoutMs`; otherwise answer `null`. Unlike `withFileLock` this never makes
 * the folder or waits it out — a caller clearing up after other people must
 * not queue behind them for an hour, nor bring back a folder they removed.
 *
 * A child process does the waiting, so giving up really lets this one finish.
 */
export const withFileLockOrNull = async <Result>(
  path: string,
  timeoutMs: number,
  body: () => Promise<Result>,
): Promise<Result | null> => {
  const held = await holdLockOrNull(path, timeoutMs);
  if (held === null) return null;
  try {
    const atPath = await statOrNull(path);
    // The wait may have been won because somebody deleted the folder: a lock on
    // a file nothing points at keeps nobody out, so it is not worth holding.
    const sameFile =
      atPath !== null &&
      (held.fileNumber === null ||
        atPath.ino === null ||
        held.fileNumber === atPath.ino);
    return sameFile ? await body() : null;
  } finally {
    await held.letGo();
  }
};
