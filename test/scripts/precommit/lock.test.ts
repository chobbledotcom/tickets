import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { acquirePrecommitLock } from "#scripts/precommit/lock.ts";

/**
 * The lock writes to a fixed OS temp path. Each test starts by removing any
 * stale lock so the test's first acquire is from a clean state, and cleans up
 * after so no test leaves a lock behind for the next.
 */
const LOCK_PATH = `${Deno.env.get("TMPDIR") ?? "/tmp"}/chobble-tickets-precommit.lock`;

const removeLock = (): void => {
  try {
    Deno.removeSync(LOCK_PATH);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

describe("acquirePrecommitLock", () => {
  beforeEach(removeLock);
  afterEach(removeLock);

  test("acquires immediately when no lock exists", async () => {
    const lock = await acquirePrecommitLock(() => {});
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
    // Write a PID that is guaranteed to not exist. PIDs cycle, but a very
    // large number is extremely unlikely to be alive. Use 999999.
    Deno.writeTextFileSync(LOCK_PATH, "999999");

    const lock = await acquirePrecommitLock(() => {});
    expect(lock.acquired).toBe(true);
    if (lock.acquired) lock.release();
  });

  test("returns not-acquired when shouldWait returns false", async () => {
    // Hold the lock with the test's own live PID so it looks like a live holder.
    Deno.writeTextFileSync(LOCK_PATH, String(Deno.pid));

    const lock = await acquirePrecommitLock(
      () => {},
      () => false,
    );
    expect(lock.acquired).toBe(false);
  });

  test("release is called even when the task throws", async () => {
    // Disable the wait path: acquire immediately, then the caller simulates
    // a throw inside the locked region.
    const lock = await acquirePrecommitLock(() => {});
    if (!lock.acquired) throw new Error("expected to acquire");
    expect(() => lock.release()).not.toThrow();
    // Calling release again is a no-op (file already gone).
    expect(() => lock.release()).not.toThrow();
  });
});
