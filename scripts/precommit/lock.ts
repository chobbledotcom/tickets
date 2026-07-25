/**
 * Cross-instance precommit lock.
 *
 * A precommit run is heavy, and two running at once just contention-saturate the
 * machine and slow each other down. This lock is keyed to the project (not the
 * working directory): another checkout or worktree of the same repo shares it,
 * so a run from a different folder still waits politely for the first to finish.
 *
 * The lock file holds the holder's PID so a waiter can name the process to kill.
 * A crashed holder leaves a stale lock; the next acquirer detects a dead PID and
 * steals the lock rather than waiting forever.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeIfExistsSync } from "#scripts/not-found.ts";

/** Where the lock lives: the OS temp dir, so it survives across worktrees. */
export const PRECOMMIT_LOCK_PATH = join(
  tmpdir(),
  "chobble-tickets-precommit.lock",
);

/** How often the waiter re-checks the lock, in milliseconds. */
const POLL_INTERVAL_MS = 2_000;

/**
 * Try to create the lock file exclusively with the holder's PID written into it.
 * `createNew: true` maps to `O_EXCL | O_CREAT`, so the create-and-write is a
 * single atomic syscall — a concurrent starter never sees an empty lock file.
 * Returns `true` when this process now owns the lock.
 */
const tryAcquire = (lockPath: string): boolean => {
  try {
    Deno.writeTextFileSync(lockPath, String(Deno.pid), { createNew: true });
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) return false;
    throw error;
  }
};

/**
 * Read the PID written into the lock, or `null` if the file is missing or its
 * contents are not a positive integer.
 */
const readHolderPid = (lockPath: string): number | null => {
  let text: string;
  try {
    text = Deno.readTextFileSync(lockPath).trim();
  } catch {
    return null;
  }
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Whether a process is currently running. On Linux, `/proc/<pid>` is the
 * no-signal liveness probe: sending a real signal to check would kill the
 * holder, and Deno does not accept numeric signal 0. Reading `/proc` is
 * signal-free and reliable. On macOS/Darwin (where `/proc` is unavailable),
 * fall back to `Deno.kill(pid, 0)` — Deno's runtime honours signal 0 as an
 * existence check even though its type doesn't include it, so the cast is the
 * supported way to pass it.
 */
const isProcessAlive = (pid: number): boolean => {
  if (Deno.build.os === "linux") {
    try {
      Deno.statSync(`/proc/${pid}`);
      return true;
    } catch {
      return false;
    }
  }
  try {
    Deno.kill(pid, 0 as unknown as Deno.Signal);
    return true;
  } catch {
    return false;
  }
};

/** Remove the lock file when this process is the holder. A stolen-then-released
 * lock may already be gone — that's the expected case; anything else surfaces. */
const release =
  (lockPath: string): (() => void) =>
  (): void => {
    removeIfExistsSync(lockPath);
  };

/**
 * Steal the lock from a dead holder. Removes the stale lock file, then acquires
 * afresh. Returns `true` when this process now owns the lock.
 */
const stealFromDeadHolder = (lockPath: string): boolean => {
  removeIfExistsSync(lockPath);
  return tryAcquire(lockPath);
};

/**
 * Try to take over a lock whose holder is dead or missing. Returns `true` when
 * this process now owns the lock.
 */
const acquireIfHolderDead = (lockPath: string): boolean => {
  const holderPid = readHolderPid(lockPath);
  if (holderPid !== null && isProcessAlive(holderPid)) return false;
  return stealFromDeadHolder(lockPath);
};

/** Build a "lock acquired" result with the release callback bound to `lockPath`.
 * When `start` is given, include how long the caller waited before acquiring. */
const lockAcquired = (lockPath: string, start?: number): LockResult =>
  start === undefined
    ? { acquired: true, release: release(lockPath) }
    : {
        acquired: true,
        release: release(lockPath),
        waitedFor: Date.now() - start,
      };

/** One poll tick: sleep, then try to acquire or steal from a dead holder.
 * Returns the lock result when this process acquired, otherwise `null` so the
 * caller can keep polling. Also calls `onWait` with the latest holder and wait. */
const pollOnce = async (
  lockPath: string,
  start: number,
  onWait: (details: { holderPid: number; waitedMs: number }) => void,
  fallbackPid: number,
): Promise<LockResult | null> => {
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  if (!tryAcquire(lockPath) && !acquireIfHolderDead(lockPath)) {
    const currentHolder = readHolderPid(lockPath) ?? fallbackPid;
    onWait({ holderPid: currentHolder, waitedMs: Date.now() - start });
    return null;
  }
  return lockAcquired(lockPath, start);
};

export type LockResult =
  /** This process acquired the lock; `release` must be called when done. */
  | { acquired: true; release: () => void }
  /** This process waited and then acquired the lock after another finished. */
  | { acquired: true; waitedFor: number; release: () => void }
  /** Could not acquire (only happens when `shouldWait` returns false). */
  | { acquired: false };

/**
 * Acquire the precommit lock. When another live tickets precommit run holds it,
 * wait patiently, printing `onWait` so the caller can tell the user they may want
 * to kill the waiter and run a more targeted check instead.
 *
 * `shouldWait` gates the wait: when it returns `false`, the function returns
 * `{ acquired: false }` immediately instead of blocking, so the caller can decide
 * to skip or run anyway. Pass `() => true` to always wait.
 *
 * `lockPath` defaults to the shared OS-temp path so two worktrees of the same
 * repo share one lock; tests pass a temp path to stay isolated from any live run.
 */
export const acquirePrecommitLock = async (
  onWait: (details: { holderPid: number; waitedMs: number }) => void,
  shouldWait: () => boolean = (): boolean => true,
  lockPath: string = PRECOMMIT_LOCK_PATH,
): Promise<LockResult> => {
  // Try a fresh acquire, or steal from a dead holder; either way we now own it.
  if (tryAcquire(lockPath) || acquireIfHolderDead(lockPath)) {
    return lockAcquired(lockPath);
  }
  if (!shouldWait()) return { acquired: false };

  const holderPid = readHolderPid(lockPath) ?? 0;
  const start = Date.now();
  onWait({ holderPid, waitedMs: 0 });

  for (;;) {
    const result = await pollOnce(lockPath, start, onWait, holderPid);
    if (result) return result;
  }
};
