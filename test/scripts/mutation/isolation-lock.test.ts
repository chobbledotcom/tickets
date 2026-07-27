import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runLockIsHeld,
  withMutationRunLock,
  withRunLockOrNull,
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

  test("takes a free lock and gives it back", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, ".mutation-runs", "mutation-free") };
      await Deno.mkdir(record.root, { recursive: true });

      expect(
        await withRunLockOrNull(record, () => Promise.resolve("done")),
      ).toBe("done");
      // Free again, or this second take would wait for ever.
      expect(
        await withRunLockOrNull(record, () => Promise.resolve("again")),
      ).toBe("again");
    });
  });

  test("gives up rather than queue behind a run that holds its folder", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, ".mutation-runs", "mutation-taken") };
      const release = Promise.withResolvers<void>();
      const holdingIt = Promise.withResolvers<void>();
      let ranInside = false;

      const holding = withMutationRunLock(record.root, () => {
        holdingIt.resolve();
        return release.promise;
      });
      await holdingIt.promise;
      const gaveUp = await withRunLockOrNull(
        record,
        () => {
          ranInside = true;
          return Promise.resolve("should not happen");
        },
        LONG_ENOUGH_TO_BE_LET_IN_MS,
      );

      expect(gaveUp).toBeNull();
      expect(ranInside).toBe(false);

      release.resolve();
      await holding;
      // The lock it gave up on is handed back when it finally arrives, so the
      // folder is free for the next run.
      await pause(LONG_ENOUGH_TO_BE_LET_IN_MS);
      expect(
        await withRunLockOrNull(record, () => Promise.resolve("free")),
      ).toBe("free");
    });
  });

  test("leaves a folder that has already gone to whoever took it", async () => {
    await withTempDir(async (root) => {
      const gone = { root: join(root, ".mutation-runs", "mutation-gone") };
      let ranInside = false;

      const answer = await withRunLockOrNull(gone, () => {
        ranInside = true;
        return Promise.resolve("should not happen");
      });

      expect(answer).toBeNull();
      expect(ranInside).toBe(false);
    });
  });

  test("gives up loudly when the folder cannot hold a lock", async () => {
    await withTempDir(async (root) => {
      const asFile = join(root, "not-a-folder");
      await Deno.writeTextFile(asFile, "");

      // Skipping in silence here would leave a copy behind with no word of it.
      await expect(
        withRunLockOrNull({ root: asFile }, () => Promise.resolve("no")),
      ).rejects.toThrow();
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

  test("reports whether a run lock is held", async () => {
    await withTempDir(async (root) => {
      const record = { root };
      expect(await runLockIsHeld(record, 100)).toBe(false);
      await withMutationRunLock(root, async () => {
        expect(await runLockIsHeld(record, 100)).toBe(true);
      });
      expect(await runLockIsHeld(record, 100)).toBe(false);

      const fileRoot = join(root, "file-root");
      await Deno.writeTextFile(fileRoot, "");
      expect(await runLockIsHeld({ root: fileRoot }, 100)).toBe(false);
    });
  });
});
