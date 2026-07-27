import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
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
  test("puts a run's lock inside the folder it was given", async () => {
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

  test("reports a run that has let its lock go as not held", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, ".mutation-runs", "mutation-done") };
      // The lock file outlives the run that made it, so a file on its own is
      // not somebody holding it.
      await withMutationRunLock(record.root, () => Promise.resolve());

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

  test("reports a run whose folder is not there as not held", async () => {
    await withTempDir(async (root) => {
      // Nothing to make a lock file in, so nobody can be holding one.
      expect(await runLockIsHeld({ root: join(root, "never-made") }, 100)).toBe(
        false,
      );
    });
  });

  test("reports a lock that goes while being looked at as not held", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, ".mutation-runs", "mutation-swept") };
      await Deno.mkdir(record.root, { recursive: true });
      const stat = Deno.stat;
      // Says the lock file is there, but it is not — which is what a clear-up
      // taking the folder away mid-question looks like.
      using _stat = stub(Deno, "stat", ((path: string | URL) =>
        `${path}`.endsWith(MUTATION_RUN_LOCK_FILE)
          ? stat(record.root)
          : stat(path)) as typeof Deno.stat);

      expect(await runLockIsHeld(record)).toBe(false);
    });
  });

  test("says so loudly when the lock cannot be looked at", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, "unreadable") };
      await Deno.mkdir(record.root, { recursive: true });
      const stat = Deno.stat;
      using _stat = stub(Deno, "stat", ((path: string | URL) =>
        `${path}`.includes("unreadable")
          ? Promise.reject(new Deno.errors.PermissionDenied("no entry"))
          : stat(path)) as typeof Deno.stat);

      // Calling this "nobody is holding it" would let a clear-up delete a run
      // that is very much still going.
      await expect(runLockIsHeld(record)).rejects.toThrow("no entry");
    });
  });

  test("says so loudly when the check itself cannot be made", async () => {
    await withTempDir(async (root) => {
      const record = { root: join(root, ".mutation-runs", "mutation-odd") };
      // A folder where the lock file should be: the check can never answer.
      await Deno.mkdir(join(record.root, MUTATION_RUN_LOCK_FILE), {
        recursive: true,
      });

      await expect(runLockIsHeld(record)).rejects.toThrow("Could not tell");
    });
  });
});
