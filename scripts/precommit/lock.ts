import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { withFileLock } from "#scripts/lock-file.ts";

export const precommitLockPath = (
  tempDirectory: string,
  userId: number,
): string => join(tempDirectory, `chobble-tickets-precommit-${userId}.lock`);

const PRECOMMIT_LOCK_PATH = precommitLockPath(tmpdir(), userInfo().uid);

/** Prevent this user from running either precommit gate concurrently. */
export const withPrecommitLock = <T>(task: () => Promise<T>): Promise<T> =>
  withFileLock(PRECOMMIT_LOCK_PATH, task);
