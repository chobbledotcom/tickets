import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runClaimIsFresh,
  takeRunClaim,
  withCopyBackLock,
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
  test("puts the claim inside the run's own folder and frees it on release", async () => {
    await withTempDir(async (root) => {
      const record = runAt(root, "mutation-new");

      const claim = await takeRunClaim(record);
      expect(await pathExists(runClaimPath(record))).toBe(true);
      expect(await runClaimIsFresh(record)).toBe(true);

      await claim.release();
      expect(await pathExists(runClaimPath(record))).toBe(false);
      expect(await runClaimIsFresh(record)).toBe(false);
    });
  });

  test("refuses a run somebody else still claims, naming the run", async () => {
    await withTempDir(async (root) => {
      const record = runAt(root, "mutation-taken");
      await writeRunClaim(record);

      await expect(takeRunClaim(record)).rejects.toThrow(
        "Timed out waiting for the claim on isolated mutation run mutation-taken",
      );
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
