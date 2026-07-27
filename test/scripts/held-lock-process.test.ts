import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type HeldLock, holdLockOrNull } from "#scripts/held-lock-process.ts";
import { withFileLock } from "#scripts/lock-file.ts";
import { withTempDir } from "#test-utils/files.ts";

/** Long enough that a lock the operating system would hand over has arrived. */
const LONG_ENOUGH_TO_BE_LET_IN_MS = 200;

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Take a lock that must be free, and let it go however the work inside ends —
 * a holder left behind would keep the next test out of the same file.
 */
const holdingLock = async (
  path: string,
  work: (held: HeldLock) => Promise<void>,
): Promise<void> => {
  const held = await holdLockOrNull(path, LONG_ENOUGH_TO_BE_LET_IN_MS);
  expect(held).not.toBeNull();
  if (held === null) return;
  try {
    await work(held);
  } finally {
    await held.letGo();
  }
};

describe("a lock held for us by another process", () => {
  test("takes a free lock and says which file it got", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");

      await holdingLock(path, async (held) => {
        // The number names the file it locked, so we can tell it is still ours.
        expect(held.fileNumber).toBe((await Deno.stat(path)).ino);
      });
    });
  });

  test("keeps everyone else out while it holds the lock", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      let ranInside = false;
      let second: Promise<void> = Promise.resolve();

      await holdingLock(path, async (_held) => {
        second = withFileLock(path, () => {
          ranInside = true;
          return Promise.resolve();
        });
        // Long enough that a lock excluding nobody would have been handed over.
        await pause(LONG_ENOUGH_TO_BE_LET_IN_MS);

        expect(ranInside).toBe(false);
      });

      await second;
      expect(ranInside).toBe(true);
    });
  });

  test("gives up on a lock somebody else is holding", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      await holdingLock(path, async () => {
        expect(await holdLockOrNull(path, 30)).toBeNull();
      });
    });
  });

  test("says so loudly when the lock cannot be taken at all", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      // A folder where the lock file should be: the lock can never be taken,
      // which is not the same as somebody else holding it.
      await Deno.mkdir(path);

      await expect(
        holdLockOrNull(path, LONG_ENOUGH_TO_BE_LET_IN_MS),
      ).rejects.toThrow("Could not take the lock");
    });
  });

  test("gives up when there is no folder to make the lock in", async () => {
    await withTempDir(async (root) => {
      const answer = await holdLockOrNull(
        join(root, "never-made", "one.lock"),
        LONG_ENOUGH_TO_BE_LET_IN_MS,
      );

      expect(answer).toBeNull();
    });
  });

  test("takes the lock again once the last holder lets go", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      await holdingLock(path, () => Promise.resolve());

      // A holder that did not really let go would make this wait for ever.
      await holdingLock(path, () => Promise.resolve());
    });
  });
});
