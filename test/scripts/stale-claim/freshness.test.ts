import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { claimIsFresh, withClaimGuard } from "#scripts/stale-claim.ts";
import {
  FRESH_FOR_MS,
  LONG_AGO_MS,
  SETTINGS,
  withClaimDir,
  withTestClaim,
  writeClaim,
} from "#test/scripts/stale-claim/helpers.ts";

describe("asking whether a claim is fresh", () => {
  test("a missing claim is nobody's", async () => {
    await withClaimDir(async (path) => {
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(false);
    });
  });

  test("a held claim is fresh and a walked-away one is not", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone\n${Date.now()}`);
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(true);

      await writeClaim(path, `someone\n${LONG_AGO_MS}`);
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(false);
    });
  });

  test("a claim stamped in the future is nobody's to trust", async () => {
    await withClaimDir(async (path) => {
      // A frozen clock, so "this very instant" below is exact, not racy.
      using _clock = new FakeTime();
      // A clock put back must not leave a dead owner's claim unstealable
      // until the wall clock catches its stamp up.
      await writeClaim(path, `someone\n${Date.now() + 5_000}`);
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(false);

      // Stamped this very instant, the claim is exactly fresh.
      await writeClaim(path, `someone\n${Date.now()}`);
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(true);
    });
  });

  test("says so loudly when there is no time at all to judge by", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, "someone\nnot-a-time");
      const stat = Deno.stat;
      using _stat = stub(Deno, "stat", (async (target: string | URL) => ({
        ...(await stat(target)),
        mtime: null,
      })) as typeof Deno.stat);

      // Neither the record nor the filesystem offers a time: guessing
      // either way could steal a live claim or keep a dead one for ever.
      await expect(claimIsFresh(path, FRESH_FOR_MS)).rejects.toThrow(
        "keeps no last-write time",
      );
    });
  });

  test("a claim from before owners were named is judged by its time", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, String(Date.now()));

      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(true);
    });
  });

  test("a disk that cannot be read does not read as nobody's claim", async () => {
    await withClaimDir(async (path) => {
      using _read = stub(Deno, "readTextFile", (() =>
        Promise.reject(
          new Deno.errors.PermissionDenied("no access"),
        )) as typeof Deno.readTextFile);

      await expect(claimIsFresh(path, FRESH_FOR_MS)).rejects.toThrow(
        "no access",
      );
    });
  });
});

describe("holding the takers' guard", () => {
  test("keeps a taker at the door until the guard is let go", async () => {
    await withClaimDir(async (path) => {
      const order: string[] = [];
      const inside = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const holding = withClaimGuard(path, async () => {
        inside.resolve();
        await release.promise;
        order.push("guard let go");
      });
      await inside.promise;

      const taking = withTestClaim(
        path,
        () => {
          order.push("claim taken");
          return Promise.resolve();
        },
        { ...SETTINGS, timeoutMs: 5_000 },
      );
      release.resolve();
      await Promise.all([holding, taking]);

      expect(order).toEqual(["guard let go", "claim taken"]);
    });
  });
});
