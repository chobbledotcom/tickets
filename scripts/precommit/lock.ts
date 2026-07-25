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
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Where the lock lives: the OS temp dir, so it survives across worktrees. */
const LOCK_PATH = join(tmpdir(), "chobble-tickets-precommit.lock");

/** How often the waiter re-checks the lock, in milliseconds. */
const POLL_INTERVAL_MS = 2_000;

/**
 * Try to create the lock file exclusively. Returns `true` when this process now
 * owns the lock. Throws on any unexpected filesystem error.
 */
const tryAcquire = (): boolean => {
  try {
    // O_EXCL: fail if the file already exists. This is the atomic acquire.
    Deno.openSync(LOCK_PATH, {
      createNew: true,
      read: true,
      write: true,
    }).close();
    Deno.writeTextFileSync(LOCK_PATH, String(Deno.pid));
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
const readHolderPid = (): number | null => {
  let text: string;
  try {
    text = Deno.readTextFileSync(LOCK_PATH).trim();
  } catch {
    return null;
  }
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Whether a process is currently running. On Linux, `_proc/<pid>` is the
 * no-signal liveness probe: sending a signal to check would either kill the
 * process (SIGTERM) or is not supported by Deno (signal 0). Reading /proc is
 * signal-free and reliable. On non-Linux, fall back to `Deno.kill(pid, 0)` —
 * some platforms honour signal 0 as an existence check.
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
    // Signal 0 is the standard no-op existence probe; Deno's type doesn't
    // include it, but the runtime honours it on POSIX platforms.
    Deno.kill(pid, 0 as unknown as Deno.Signal);
    return true;
  } catch {
    return false;
  }
};

/** Remove the lock file when this process is the holder. */
const release = (): void => {
  try {
    Deno.removeSync(LOCK_PATH);
  } catch (error) {
    // Already gone (a crashed holder's stale lock was stolen and released) —
    // the only expected case. Surface anything else.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

/**
 * Steal the lock from a dead holder. Removes the stale lock file, then acquires
 * afresh. Returns `true` when this process now owns the lock.
 */
const stealFromDeadHolder = (): boolean => {
  try {
    Deno.removeSync(LOCK_PATH);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return tryAcquire();
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
 */
export const acquirePrecommitLock = async (
  onWait: (details: { holderPid: number; waitedMs: number }) => void,
  shouldWait: () => boolean = (): boolean => true,
): Promise<LockResult> => {
  if (tryAcquire()) {
    return { acquired: true, release };
  }

  const holderPid = readHolderPid();
  if (holderPid === null || !isProcessAlive(holderPid)) {
    // Stale lock from a crashed holder — take it.
    if (stealFromDeadHolder()) return { acquired: true, release };
  }

  if (!shouldWait()) return { acquired: false };

  const start = Date.now();
  onWait({ holderPid: holderPid!, waitedMs: 0 });

  // Poll until the holder releases or dies.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (tryAcquire()) {
      return { acquired: true, waitedFor: Date.now() - start, release };
    }
    const currentHolder = readHolderPid();
    if (currentHolder !== null && !isProcessAlive(currentHolder)) {
      if (stealFromDeadHolder()) {
        return { acquired: true, waitedFor: Date.now() - start, release };
      }
    }
    onWait({ holderPid: currentHolder ?? holderPid!, waitedMs: Date.now() - start });
  }
};
