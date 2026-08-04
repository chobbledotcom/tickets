import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { claimIsFresh, keepClaimFresh } from "#scripts/stale-claim.ts";
import {
  countClaimReads,
  eventually,
  FRESH_FOR_MS,
  holdOnFakeClock,
  holdThenLoseClaim,
  holdWhileTouchesFail,
  LONG_AGO_MS,
  tickBy,
  watchClaimReads,
  withClaimDir,
  writeClaim,
} from "#test/scripts/stale-claim/helpers.ts";

describe("a holder whose touches stop landing or land elsewhere", () => {
  test("carries on when every touch fails but the claim stays its own", async () => {
    await withClaimDir((path) =>
      holdWhileTouchesFail(path, async ({ held, time }) => {
        // The file ages unwritten for the whole window — but nobody took the
        // claim, so no duplicate work can have started and the hold may end
        // quietly.
        await tickBy(time, 10, 10, 10, 10);

        held.release();
        await held.holding;
        await expect(Deno.stat(path)).rejects.toThrow();
      }),
    );
  });

  test("carries on past a failed touch, touching again so the blip heals", async () => {
    await withClaimDir((path) =>
      holdWhileTouchesFail(path, async ({ held, recover, time }) => {
        await tickBy(time, 10);
        recover();
        await tickBy(time, 10, 5);

        // Touched again after the blip: fresh, judged against a window far
        // smaller than the time since the claim was first written — once
        // the touch's real write has landed.
        await eventually(() => claimIsFresh(path, 12));
        held.release();
        await held.holding;
      }),
    );
  });
});

describe("a holder whose claim is taken while it works", () => {
  test("stops touching and reports a claim another taker now holds", async () => {
    await withClaimDir(async (path) => {
      // A taker judged the aged claim abandoned and took it.
      const { held, takenRecord, time } = await holdThenLoseClaim(path);
      using _clock = time;

      // The next touch finds somebody else's name and must not write.
      await tickBy(time, 10, 10);

      expect(await Deno.readTextFile(path)).toBe(takenRecord);
      held.release();
      await expect(held.holding).rejects.toThrow("was lost while the work ran");
      // The new owner's record is left exactly as it was.
      expect(await Deno.readTextFile(path)).toBe(takenRecord);
    });
  });

  test("reports a claim that vanished mid-run without re-creating it", async () => {
    await withClaimDir(async (path) => {
      const { held, time } = await holdOnFakeClock(path);
      using _clock = time;
      // A taker took the aged claim, finished, and released it.
      await Deno.remove(path);

      await tickBy(time, 10, 10);

      held.release();
      await expect(held.holding).rejects.toThrow("was lost while the work ran");
      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });

  test("stops looking at a claim it has learned is lost", async () => {
    await withClaimDir(async (path) => {
      const { held, time } = await holdThenLoseClaim(path);
      using _clock = time;
      const counter = { reads: 0 };
      using _read = countClaimReads(path, counter);

      // The touch that discovers the loss is the last look it takes.
      await tickBy(time, 10);
      await eventually(() => Promise.resolve(counter.reads > 0));
      const readsAtDiscovery = counter.reads;
      await tickBy(time, 10, 10, 10);

      expect(counter.reads).toBe(readsAtDiscovery);
      held.release();
      await expect(held.holding).rejects.toThrow("was lost while the work ran");
    });
  });

  test("reports at release a taking no touch was awake to see", async () => {
    await withClaimDir(async (path) => {
      // Touches far rarer than the hold is long: the only ownership check
      // left is the release's own.
      const { held, takenRecord, time } = await holdThenLoseClaim(path, 60_000);
      using _clock = time;

      await tickBy(time, 40);

      held.release();
      await expect(held.holding).rejects.toThrow("was lost while the work ran");
      expect(await Deno.readTextFile(path)).toBe(takenRecord);
    });
  });
});

describe("keeping somebody else's claim fresh for them", () => {
  test("touches it from the very first moment, keeping their name on it", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `their-supervisor\n${LONG_AGO_MS}`);

      const claim = await keepClaimFresh(path, {
        staleMs: FRESH_FOR_MS,
        touchMs: FRESH_FOR_MS,
      });
      expect(claim.ownedBy).toBe("their-supervisor");
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(true);
      await claim.stopTouching();

      // Stopping never removes the claim: it stays theirs to release.
      expect(
        (await Deno.readTextFile(path)).startsWith("their-supervisor"),
      ).toBe(true);
    });
  });

  test("reports a claim taken while it was being kept fresh", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `their-supervisor\n${Date.now()}`);
      using time = new FakeTime();
      const claim = await keepClaimFresh(path, { staleMs: 30, touchMs: 10 });
      await writeClaim(path, `new-owner\n${Date.now()}`);

      await tickBy(time, 10);

      await expect(claim.stopTouching()).rejects.toThrow(
        "was lost while the work ran",
      );
      // Not the keeper's to touch or remove: the new owner's record stays.
      expect((await Deno.readTextFile(path)).startsWith("new-owner")).toBe(
        true,
      );
    });
  });

  test("reports a claim taken between the look and the first touch", async () => {
    await withClaimDir(async (path) => {
      // The file already carries a taker's record; only the keeper's first
      // look still sees the supervisor it set out to keep the claim for.
      await writeClaim(path, `new-owner\n${Date.now()}`);
      let firstLook = true;
      using _read = watchClaimReads(path, () => {
        if (!firstLook) return;
        firstLook = false;
        return `their-supervisor\n${Date.now()}`;
      });

      await expect(
        keepClaimFresh(path, { staleMs: FRESH_FOR_MS, touchMs: FRESH_FOR_MS }),
      ).rejects.toThrow("was lost while the work ran");
      // The taker's record is untouched: no touch may land on it.
      expect((await Deno.readTextFile(path)).startsWith("new-owner")).toBe(
        true,
      );
    });
  });

  test("refuses a claim that names nobody to keep it fresh for", async () => {
    await withClaimDir(async (path) => {
      // A record from before owners were named carries a time alone.
      await writeClaim(path, String(Date.now()));

      await expect(
        keepClaimFresh(path, { staleMs: FRESH_FOR_MS, touchMs: FRESH_FOR_MS }),
      ).rejects.toThrow("names no owner");
    });
  });

  test("refuses when there is no claim there at all", async () => {
    await withClaimDir(async (path) => {
      await expect(
        keepClaimFresh(path, { staleMs: FRESH_FOR_MS, touchMs: FRESH_FOR_MS }),
      ).rejects.toThrow();
    });
  });
});
