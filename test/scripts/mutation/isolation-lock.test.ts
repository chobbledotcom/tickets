import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runClaimIsFresh,
  withCopyBackLock,
  withCopyBackLockWhen,
  withRunClaim,
} from "#scripts/mutation/isolation-lock.ts";
import {
  copyBackLockPath,
  runClaimPath,
} from "#scripts/mutation/isolation-state.ts";
import {
  LONG_AGO,
  withTempDir,
  writeRunClaim,
} from "#test/scripts/mutation/isolation-helpers.ts";
import { pathExists } from "#test-utils/files.ts";

/**
 * Long enough for the operating system to hand over a lock it was willing to
 * hand over. Without this pause a lock that excludes nobody still looks like
 * it is working, because the second holder has not been let in yet either.
 */
const LONG_ENOUGH_TO_BE_LET_IN_MS = 30;

const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const runAt = (root: string, name: string): { id: string; root: string } => ({
  id: name,
  root: join(root, ".mutation-runs", name),
});

describe("the claim a supervisor holds on its run", () => {
  test("claims the run's own folder for the work and frees it after", async () => {
    await withTempDir(async (root) => {
      const record = runAt(root, "mutation-new");

      const answer = await withRunClaim(record, async () => {
        expect(await pathExists(runClaimPath(record))).toBe(true);
        expect(await runClaimIsFresh(record)).toBe(true);
        return 7;
      });

      expect(answer).toBe(7);
      expect(await pathExists(runClaimPath(record))).toBe(false);
      expect(await runClaimIsFresh(record)).toBe(false);
    });
  });

  test("refuses a run somebody else still claims, naming the run", async () => {
    await withTempDir(async (root) => {
      const record = runAt(root, "mutation-taken");
      await writeRunClaim(record);
      let ranAnyway = false;

      await expect(
        withRunClaim(record, () => {
          ranAnyway = true;
          return Promise.resolve();
        }),
      ).rejects.toThrow(
        "Timed out waiting for the claim on isolated mutation run mutation-taken",
      );
      expect(ranAnyway).toBe(false);
    });
  });

  test("counts a walked-away claim as nobody's", async () => {
    await withTempDir(async (root) => {
      const record = runAt(root, "mutation-left");
      await writeRunClaim(record, LONG_AGO.getTime());

      expect(await runClaimIsFresh(record)).toBe(false);
    });
  });

  test("counts a run with no claim at all as nobody's", async () => {
    await withTempDir(async (root) => {
      expect(await runClaimIsFresh(runAt(root, "mutation-none"))).toBe(false);
    });
  });
});

describe("the lock that keeps two runs out of one copy-back", () => {
  test("runs work that is still wanted after taking the lock", async () => {
    await withTempDir(async (root) => {
      expect(
        await withCopyBackLockWhen(
          root,
          () => true,
          0,
          () => Promise.resolve(7),
        ),
      ).toBe(7);
    });
  });

  test("skips work that is no longer wanted after taking the lock", async () => {
    await withTempDir(async (root) => {
      let ran = false;
      const result = await withCopyBackLockWhen(
        root,
        () => false,
        3,
        () => {
          ran = true;
          return Promise.resolve(7);
        },
      );

      expect(result).toBe(3);
      expect(ran).toBe(false);
    });
  });

  test("keeps a second run out until the first has brought its files back", async () => {
    await withTempDir(async (root) => {
      const order: string[] = [];
      const firstInside = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();

      const first = withCopyBackLock(root, async () => {
        order.push("first in");
        firstInside.resolve();
        await releaseFirst.promise;
        order.push("first out");
      });
      await firstInside.promise;

      const second = withCopyBackLock(root, () => {
        order.push("second in");
        return Promise.resolve();
      });
      await pause(LONG_ENOUGH_TO_BE_LET_IN_MS);
      expect(order).toEqual(["first in"]);

      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(["first in", "first out", "second in"]);
      expect(await pathExists(copyBackLockPath(root))).toBe(true);
    });
  });
});
