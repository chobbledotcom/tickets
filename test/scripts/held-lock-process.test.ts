import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { holdLockOrNull } from "#scripts/held-lock-process.ts";
import { withFileLock } from "#scripts/lock-file.ts";
import { withTempDir } from "#test-utils/files.ts";

/** Long enough that a lock the operating system would hand over has arrived. */
const LONG_ENOUGH_TO_BE_LET_IN_MS = 200;

describe("a lock held for us by another process", () => {
  test("takes a free lock and says which file it got", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");

      const held = await holdLockOrNull(path, LONG_ENOUGH_TO_BE_LET_IN_MS);

      expect(held).not.toBeNull();
      // The number names the file it locked, so we can tell it is still ours.
      expect(held?.fileNumber).toBe((await Deno.stat(path)).ino);
      await held?.letGo();
    });
  });

  test("keeps everyone else out while it holds the lock", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      const held = await holdLockOrNull(path, LONG_ENOUGH_TO_BE_LET_IN_MS);
      let ranInside = false;

      const second = withFileLock(path, () => {
        ranInside = true;
        return Promise.resolve();
      });
      await new Promise((resolve) =>
        setTimeout(resolve, LONG_ENOUGH_TO_BE_LET_IN_MS),
      );

      expect(ranInside).toBe(false);

      await held?.letGo();
      await second;
      expect(ranInside).toBe(true);
    });
  });

  test("gives up on a lock somebody else is holding", async () => {
    await withTempDir(async (root) => {
      const path = join(root, "one.lock");
      const first = await holdLockOrNull(path, LONG_ENOUGH_TO_BE_LET_IN_MS);

      expect(await holdLockOrNull(path, 30)).toBeNull();

      await first?.letGo();
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
      const first = await holdLockOrNull(path, LONG_ENOUGH_TO_BE_LET_IN_MS);
      await first?.letGo();

      // A holder that did not really let go would make this wait for ever.
      const second = await holdLockOrNull(path, LONG_ENOUGH_TO_BE_LET_IN_MS);

      expect(second).not.toBeNull();
      await second?.letGo();
    });
  });
});
