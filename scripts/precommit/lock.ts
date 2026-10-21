import { join } from "@std/path";
import { withFileLock } from "#scripts/lock-file.ts";

export const precommitLockPath = (
  tempDirectory: string,
  userId: number,
): string => join(tempDirectory, `chobble-tickets-precommit-${userId}.lock`);

/** The lock file is per user, so the lock path needs this user's id. */
const currentUserId = (): number => {
  const uid = Deno.uid();
  if (uid === null) {
    throw new Error(
      "The precommit lock needs a numeric user id, which this platform does not provide",
    );
  }
  return uid;
};

export const precommitLockAt =
  (path: string): (<T>(task: () => Promise<T>) => Promise<T>) =>
  <T>(task: () => Promise<T>): Promise<T> =>
    withFileLock(path, task);

/** Prevent this user from running either precommit gate concurrently. */
export const withPrecommitLock = async <T>(
  task: () => Promise<T>,
): Promise<T> =>
  await precommitLockAt(
    precommitLockPath(Deno.env.get("TMPDIR") ?? "/tmp", currentUserId()),
  )(task);
