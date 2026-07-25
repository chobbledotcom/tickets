import { join } from "node:path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { acquirePrecommitLock } from "#scripts/precommit/lock.ts";

/**
 * Each test file run uses its own unique lock path under the OS temp dir, so
 * tests never touch the real precommit lock at `PRECOMMIT_LOCK_PATH` — a
 * concurrent `deno task test:coverage` could be running precommit for real, and
 * colliding with its lock (or stealing it) would make both flaky.
 */
const LOCK_PATH = join(
  Deno.env.get("TMPDIR") ?? "/tmp",
  `chobble-tickets-precommit-test-${Deno.pid}-${Date.now()}.lock`,
);

const removeLock = (): void => {
  try {
    Deno.removeSync(LOCK_PATH);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

/**
 * Produce a PID that has definitely already exited. We spawn a process that
 * exits immediately and wait for it to finish; its PID is now recycled-free and
 * reads as dead under the lock's liveness probe. This is deterministic on every
 * platform, unlike picking a large number and hoping it isn't in use.
 */
const deadPid = async (): Promise<number> => {
  const child = new Deno.Command("true", {
    stderr: "null",
    stdout: "null",
  }).spawn();
  await child.status;
  return child.pid;
};

describe("acquirePrecommitLock", () => {
  beforeEach(removeLock);
  afterEach(removeLock);

  test("acquires immediately when no lock exists", async () => {
    const lock = await acquirePrecommitLock(
      () => {},
      () => true,
      LOCK_PATH,
    );
    expect(lock.acquired).toBe(true);
    if (lock.acquired) lock.release();
    // The lock file is gone after release.
    expect(() => Deno.readTextFileSync(LOCK_PATH)).toThrow();
  });

  test("waits when another process holds the lock, then acquires after release", async () => {
    // Hold the lock with a live PID that is not the acquirer's own. The test's
    // own Deno process PID is alive and foreign to `acquirePrecommitLock`
    // (which only writes its own PID when *it* acquires), so the waiter must
    // wait until we remove the lock file.
    Deno.writeTextFileSync(LOCK_PATH, String(Deno.pid));

    let waitCalls = 0;
    let acquired = false;

    // Start the waiter in the background.
    const waiter = (async () => {
      const lock = await acquirePrecommitLock(
        () => {
          waitCalls++;
        },
        () => true,
        LOCK_PATH,
      );
      acquired = lock.acquired;
      if (lock.acquired) lock.release();
    })();

    // Let the waiter detect the held lock and call onWait at least once.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(waitCalls).toBeGreaterThan(0);
    expect(acquired).toBe(false);

    // Release the foreign lock so the waiter can acquire.
    removeLock();

    await waiter;
    expect(acquired).toBe(true);
  });

  test("steals the lock when the holder PID is dead", async () => {
    // Use a PID from a process that has already exited, so the liveness probe
    // deterministically reports it dead on every platform.
    const pid = await deadPid();
    Deno.writeTextFileSync(LOCK_PATH, String(pid));

    const lock = await acquirePrecommitLock(
      () => {},
      () => true,
      LOCK_PATH,
    );
    expect(lock.acquired).toBe(true);
    if (lock.acquired) lock.release();
  });

  test("returns not-acquired when shouldWait returns false", async () => {
    // Hold the lock with the test's own live PID so it looks like a live holder.
    Deno.writeTextFileSync(LOCK_PATH, String(Deno.pid));

    const lock = await acquirePrecommitLock(
      () => {},
      () => false,
      LOCK_PATH,
    );
    expect(lock.acquired).toBe(false);
  });

  test("release is idempotent and safe to call twice", async () => {
    const lock = await acquirePrecommitLock(
      () => {},
      () => true,
      LOCK_PATH,
    );
    if (!lock.acquired) throw new Error("expected to acquire");
    expect(() => lock.release()).not.toThrow();
    // Calling release again is a no-op (file already gone).
    expect(() => lock.release()).not.toThrow();
  });
});
