import { join } from "@std/path";
import { withLockAt } from "#scripts/lock-file.ts";

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

/** Prevent this user from running either precommit gate concurrently. */
export const withPrecommitLock = async <T>(
  task: () => Promise<T>,
): Promise<T> =>
  await withLockAt(
    precommitLockPath(Deno.env.get("TMPDIR") ?? "/tmp", currentUserId()),
  )(task);
