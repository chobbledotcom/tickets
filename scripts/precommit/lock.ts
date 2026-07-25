/**
 * Cross-worktree precommit lock.
 *
 * The file is only a stable rendezvous point. Ownership lives in the kernel's
 * advisory lock and is tied to the open file handle, so process exit releases
 * it automatically. There is no PID, stale state, or takeover race to repair.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "#scripts/lock-file.ts";

/** One project-wide path shared by every checkout and worktree. */
export const PRECOMMIT_LOCK_PATH = join(
  tmpdir(),
  "chobble-tickets-precommit.lock",
);

/** Run `task` while this process owns the project-wide precommit lock. */
export const withPrecommitLock = <T>(
  task: () => Promise<T>,
  lockPath: string = PRECOMMIT_LOCK_PATH,
): Promise<T> => withFileLock(lockPath, task);
