import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  ageFile,
  expectClaimRefused,
  LONG_AGO_MS,
  withClaimDir,
  withTestClaim,
  writeClaim,
} from "#test/scripts/stale-claim/helpers.ts";

describe("taking a claim", () => {
  test("takes a free claim, writing who holds it and since when", async () => {
    await withClaimDir(async (path) => {
      const before = Date.now();
      await withTestClaim(path, async () => {
        const [owner, time] = (await Deno.readTextFile(path)).split("\n");
        // A random name and the time of the last touch, nothing else.
        expect(owner).toMatch(/^[0-9a-f-]{36}$/);
        expect(Number(time)).toBeGreaterThanOrEqual(before);
        expect(Number(time)).toBeLessThanOrEqual(Date.now());
      });
    });
  });

  test("refuses while somebody else's claim is fresh", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone-else\n${Date.now()}`);

      await expectClaimRefused(path);
    });
  });

  test("removes and takes over a claim whose owner walked away", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone-else\n${LONG_AGO_MS}`);

      await withTestClaim(path, async () => {
        expect(await Deno.readTextFile(path)).not.toContain("someone-else");
      });
    });
  });

  test("judges a claim by its file's age when it names no readable time", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, "someone-else\nnot-a-time");
      await ageFile(path, LONG_AGO_MS);

      await withTestClaim(path, () => Promise.resolve());
    });
  });

  test("keeps a fresh file's claim when its time has nothing after it", async () => {
    await withClaimDir(async (path) => {
      // A time with a newline and nothing else is not a record we ever write,
      // so the file's own age decides — and this file is new.
      await writeClaim(path, `${LONG_AGO_MS}\n`);

      await expectClaimRefused(path);
    });
  });

  test("takes over a claim naming a time from the very start of the clock", async () => {
    await withClaimDir(async (path) => {
      // The file was touched a moment ago, so only reading the time it
      // claims — 1970, however unlikely — can tell that it is abandoned.
      await writeClaim(path, "someone-else\n1");

      await withTestClaim(path, () => Promise.resolve());
    });
  });

  test("leaves a freshly made claim alone while its time is unreadable", async () => {
    await withClaimDir(async (path) => {
      // A taker between creating the file and writing the record: the file is
      // moments old, so it is somebody's claim, not an abandoned one.
      await writeClaim(path, "");

      await expectClaimRefused(path);
    });
  });

  test("surfaces a claim file that cannot be made at all", async () => {
    await withClaimDir(async (path) => {
      using _open = stub(Deno, "open", (() =>
        Promise.reject(
          new Deno.errors.PermissionDenied("no access"),
        )) as typeof Deno.open);

      await expect(
        withTestClaim(path, () => Promise.resolve()),
      ).rejects.toThrow("no access");
    });
  });

  test("takes the claim when a stale one vanishes during the steal", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `someone-else\n${LONG_AGO_MS}`);

      const remove = Deno.remove;
      using _remove = stub(Deno, "remove", (async (
        target: string | URL,
        options?: Deno.RemoveOptions,
      ) => {
        // Another taker clears the stale claim first; ours must carry on.
        await remove(target, options).catch(() => {});
        throw new Deno.errors.NotFound("already gone");
      }) as typeof Deno.remove);

      await withTestClaim(path, () => Promise.resolve());
    });
  });
});
