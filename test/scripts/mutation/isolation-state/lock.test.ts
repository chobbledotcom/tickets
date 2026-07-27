import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runLockIsHeld,
  withMutationRunLock,
} from "#scripts/mutation/isolation-lock.ts";
import { MUTATION_RUN_LOCK_FILE } from "#scripts/mutation/isolation-state.ts";
import { withTempDir } from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";

/**
 * Long enough for the operating system to hand over a lock it was willing to
 * hand over. Without this pause a lock that excludes nobody still looks like
 * it is working, because the second holder has not been let in yet either.
 */
const LONG_ENOUGH_TO_BE_LET_IN_MS = 30;

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("the lock that keeps two runs out of one folder", () => {
  test("makes the run folder it is asked to lock", async () => {
    await withTempDir(async (root) => {
      const runFolder = join(root, ".mutation-runs", "mutation-new");

      expect(
        await withMutationRunLock(runFolder, () => Promise.resolve(7)),
      ).toBe(7);

      expect(await pathExists(join(runFolder, MUTATION_RUN_LOCK_FILE))).toBe(
        true,
      );
    });
  });

  test("keeps a second run out until the first one is done", async () => {
    await withTempDir(async (root) => {
      const runFolder = join(root, ".mutation-runs", "mutation-shared");
      const order: string[] = [];
      const firstInside = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();

      const first = withMutationRunLock(runFolder, async () => {
        order.push("first in");
        firstInside.resolve();
        await releaseFirst.promise;
        order.push("first out");
      });
      await firstInside.promise;

      const second = withMutationRunLock(runFolder, () => {
        order.push("second in");
        return Promise.resolve();
      });
      await pause(LONG_ENOUGH_TO_BE_LET_IN_MS);

      expect(order).toEqual(["first in"]);

      releaseFirst.resolve();
      await Promise.all([first, second]);

      expect(order).toEqual(["first in", "first out", "second in"]);
    });
  });

  test("hands the lock back when the work inside it fails", async () => {
    await withTempDir(async (root) => {
      const runFolder = join(root, ".mutation-runs", "mutation-failing");

      await expect(
        withMutationRunLock(runFolder, () => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");

      // A run that could not take the lock back would hang here instead.
      expect(
        await withMutationRunLock(runFolder, () => Promise.resolve("ok")),
      ).toBe("ok");
    });
  });

  test("reports a run nobody is holding as not held", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, ".mutation-runs", "mutation-idle") };
      await Deno.mkdir(record.root, { recursive: true });

      // No timeout given, so this also checks the standard one is long enough
      // to tell "free" from "held" rather than calling everything held.
      expect(await runLockIsHeld(record)).toBe(false);
    });
  });

  test("reports a run somebody is holding as held", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, ".mutation-runs", "mutation-busy") };
      const asked = Promise.withResolvers<boolean>();
      const release = Promise.withResolvers<void>();

      const holding = withMutationRunLock(record.root, async () => {
        asked.resolve(await runLockIsHeld(record));
        await release.promise;
      });

      expect(await asked.promise).toBe(true);
      release.resolve();
      await holding;
    });
  });
});
