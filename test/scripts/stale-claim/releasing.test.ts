import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  doNothing,
  expectClaimRefused,
  holdClaimUntilReleased,
  SETTINGS,
  withClaimDir,
  withTestClaim,
  writeClaim,
} from "#test/scripts/stale-claim/helpers.ts";

describe("releasing a claim", () => {
  test("removes the claim so the next taker finds it free", async () => {
    await withClaimDir(async (path) => {
      await withTestClaim(path, doNothing);

      await expect(Deno.stat(path)).rejects.toThrow();
      await withTestClaim(path, doNothing);
    });
  });

  test("reports a claim that has since become somebody else's, leaving it", async () => {
    await withClaimDir(async (path) => {
      await expect(
        withTestClaim(path, () => writeClaim(path, `new-owner\n${Date.now()}`)),
      ).rejects.toThrow("was lost while the work ran");

      expect((await Deno.readTextFile(path)).startsWith("new-owner")).toBe(
        true,
      );
    });
  });

  test("frees the claim even when the work itself fails", async () => {
    await withClaimDir(async (path) => {
      await expect(
        withTestClaim(path, () => Promise.reject(new Error("the work broke"))),
      ).rejects.toThrow("the work broke");

      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });

  test("notes a lost claim alongside the work's own failure", async () => {
    await withClaimDir(async (path) => {
      await expect(
        withTestClaim(path, async () => {
          await writeClaim(path, `new-owner\n${Date.now()}`);
          throw new Error("the work broke");
        }),
      ).rejects.toThrow(/the work broke.*was lost while the work ran/s);

      // The new owner's record is not the failed work's to remove.
      expect((await Deno.readTextFile(path)).startsWith("new-owner")).toBe(
        true,
      );
    });
  });

  test("reports a claim that is already gone as lost", async () => {
    await withClaimDir(async (path) => {
      await expect(
        withTestClaim(path, () => Deno.remove(path)),
      ).rejects.toThrow("was lost while the work ran");

      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });
});

describe("waiting for a claim", () => {
  test("does the work once the claim's holder lets go, then frees it", async () => {
    await withClaimDir(async (path) => {
      const held = await holdClaimUntilReleased(path);
      setTimeout(held.release, 20);

      const answer = await withTestClaim(
        path,
        () => Promise.resolve("worked"),
        { ...SETTINGS, timeoutMs: 5_000 },
      );

      await held.holding;
      expect(answer).toBe("worked");
      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });

  test("pauses between tries instead of asking as fast as it can", async () => {
    await withClaimDir(async (path) => {
      const held = await holdClaimUntilReleased(path);
      let tries = 0;
      const open = Deno.open;
      using _open = stub(Deno, "open", ((
        target: string | URL,
        options?: Deno.OpenOptions,
      ) => {
        if (`${target}` === path && options?.createNew) tries += 1;
        return open(target, options);
      }) as typeof Deno.open);

      await expectClaimRefused(path, {
        ...SETTINGS,
        retryMs: 5,
        timeoutMs: 60,
      });

      // Sixty milliseconds of waiting, five apart, is a handful of tries.
      // With no pause between them it would be many thousands.
      expect(tries).toBeGreaterThan(1);
      expect(tries).toBeLessThan(50);

      held.release();
      await held.holding;
    });
  });

  test("gives up by name when the holder never lets go", async () => {
    await withClaimDir(async (path) => {
      const held = await holdClaimUntilReleased(path);

      await expectClaimRefused(path, { ...SETTINGS, timeoutMs: 20 });

      held.release();
      await held.holding;
    });
  });
});
