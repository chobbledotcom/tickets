import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { claimIsFresh } from "#scripts/stale-claim.ts";
import {
  countClaimReads,
  eventually,
  holdOnFakeClock,
  settle,
  tickBy,
  withClaimDir,
  withTestClaim,
  writeClaim,
} from "#test/scripts/stale-claim/helpers.ts";

describe("keeping a claim fresh while it is held", () => {
  test("touches the claim on time, so it never reads as walked away", async () => {
    await withClaimDir(async (path) => {
      const { held, time } = await holdOnFakeClock(path, 5);
      using _clock = time;
      // Two rounds, so the touch after a touch is proven too — not just the
      // first one armed when the claim was taken.
      for (let round = 0; round < 2; round += 1) {
        // Age the record — keeping its owner — as if the holder had
        // stalled for a long while without anyone taking the claim.
        const [owner] = (await Deno.readTextFile(path)).split("\n");
        await writeClaim(path, `${owner}\n${Date.now() - 40}`);
        expect(await claimIsFresh(path, 25)).toBe(false);

        await time.tickAsync(5);
        // The touch's write is real disk work; wait for it to land.
        await eventually(() => claimIsFresh(path, 25));
      }
      held.release();
      await held.holding;
    });
  });

  test("a touch armed but not yet landed dies with the release", async () => {
    await withClaimDir(async (path) => {
      const { held, time } = await holdOnFakeClock(path, 2);
      using _clock = time;
      // A few touches land, so the release meets a rearmed timer rather
      // than the very first one.
      await tickBy(time, 2, 2, 2, 1);

      held.release();
      await held.holding;

      await expect(Deno.stat(path)).rejects.toThrow();
      // Time for a stray touch to land, if one had survived the release.
      await tickBy(time, 25);
      await settle();
      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });

  test("a touch already under way when the release starts is waited out", async () => {
    await withClaimDir(async (path) => {
      // The second write to the claim — the first touch — is held in flight
      // until the test lets it finish.
      const writeStarted = Promise.withResolvers<void>();
      const finishWrite = Promise.withResolvers<void>();
      const writeTextFile = Deno.writeTextFile;
      let writes = 0;
      using _write = stub(Deno, "writeTextFile", (async (
        target: string | URL,
        data: string | ReadableStream<string>,
        options?: Deno.WriteFileOptions,
      ) => {
        if (`${target}` === path) {
          writes += 1;
          if (writes === 2) {
            writeStarted.resolve();
            await finishWrite.promise;
          }
        }
        return writeTextFile(target, data, options);
      }) as typeof Deno.writeTextFile);
      const { held, time } = await holdOnFakeClock(path, 5);
      using _clock = time;
      await time.tickAsync(5);
      await writeStarted.promise;

      held.release();
      let released = false;
      const holding = (async () => {
        await held.holding;
        released = true;
      })();
      await settle();
      // Still waiting on the touch in flight: letting go now could leave
      // that write landing after the claim was removed.
      expect(released).toBe(false);

      finishWrite.resolve();
      await holding;
      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });

  test("a timer that fires after the release writes nothing", async () => {
    await withClaimDir(async (path) => {
      // Capture the touch timers instead of running them, so the test can
      // fire one "late" — after the release — the way a real timer can go
      // off in the very moment of the stop.
      const lateTouches: Array<() => void> = [];
      using _timer = stub(globalThis, "setTimeout", ((handler: () => void) => {
        lateTouches.push(handler);
        return 0;
      }) as unknown as typeof setTimeout);

      await withTestClaim(path, () => Promise.resolve());
      const counter = { reads: 0 };
      using _read = countClaimReads(path, counter);
      for (const touch of lateTouches) touch();

      // Real time for anything wrongly started to land, if there was any.
      await settle();
      // The late touch bailed before so much as looking at the claim.
      expect(counter.reads).toBe(0);
      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });
});
