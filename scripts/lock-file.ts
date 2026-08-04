/**
 * Advisory file locks: one holder at a time, across processes.
 *
 * A lock is only worth something while the file it holds is the file at its
 * path. Anything that clears folders away can unlink a lock somebody is queued
 * on, and that waiter is then handed a file nothing points at, which keeps
 * nobody out. So every lock here is checked once it is taken.
 */

import { dirname } from "@std/path";
import { nullIfNotFound, statOrNull } from "#scripts/not-found.ts";

/** Open (creating if needed) a file to hold an advisory lock. */
const openLockFile = (path: string): Promise<Deno.FsFile> =>
  Deno.open(path, { create: true, read: true, write: true });

/**
 * The lock file at `path`, or `null` when there is no folder to make it in.
 * A disk that cannot be opened at all is a different answer, and throws.
 */
const openLockFileOrNull = (path: string): Promise<Deno.FsFile | null> =>
  nullIfNotFound(openLockFile(path));

/**
 * Is the file numbered `fileNumber` the one sitting at `path`? A disk that
 * keeps no file numbers cannot tell two apart, so there it is taken at its word.
 */
const sameFileAt = async (
  path: string,
  fileNumber: number,
): Promise<boolean> => {
  const atPath = await statOrNull(path);
  if (atPath === null) return false;
  return atPath.ino === null || fileNumber === atPath.ino;
};

/**
 * Hold the lock at `path` while `body` runs, waiting as long as it takes and
 * making the folder the lock lives in. A clear-up can take that folder away
 * mid-wait, leaving a lock with nothing pointing at it, so it makes the folder
 * and takes the lock again until it has the one at the path.
 */
export const withFileLock = async <Result>(
  path: string,
  body: () => Promise<Result>,
): Promise<Result> => {
  for (;;) {
    await Deno.mkdir(dirname(path), { recursive: true });
    const file = await openLockFileOrNull(path);
    if (file !== null) {
      await file.lock(true);
      try {
        const { ino } = await file.stat();
        if (await sameFileAt(path, Number(ino))) return await body();
      } finally {
        await file.unlock();
        file.close();
      }
    }
  }
};
