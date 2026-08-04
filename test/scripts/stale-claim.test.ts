import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import {
  claimIsFresh,
  keepClaimFresh,
  withClaim,
  withClaimGuard,
} from "#scripts/stale-claim.ts";
import { withTempDir } from "#test-utils/files.ts";

/** Generous enough that nothing ages out mid-test on a slow machine. */
const FRESH_FOR_MS = 60_000;

/**
 * One try, touching so rarely that a short test never sees a touch it did not
 * ask for: a claim that is not free at once is reported straight away.
 */
const SETTINGS = {
  name: "the test claim",
  retryMs: 1,
  staleMs: FRESH_FOR_MS,
  timeoutMs: 0,
  touchMs: FRESH_FOR_MS,
};

const LONG_AGO_MS = Date.now() - 60 * 60 * 1000;

const withClaimDir = <Result>(
  run: (path: string) => Promise<Result>,
): Promise<Result> =>
  withTempDir((dir) => run(join(dir, "job.claim")), {
    prefix: "stale-claim-",
  });

const writeClaim = (path: string, text: string): Promise<void> =>
  Deno.writeTextFile(path, text);

const ageFile = async (path: string, at: number): Promise<void> => {
  const date = new Date(at);
  await Deno.utime(path, date, date);
};

/** Hold the claim around `run`, with the quick one-try settings above. */
const withTestClaim = <Result>(
  path: string,
  run: () => Promise<Result>,
  settings = SETTINGS,
): Promise<Result> => withClaim(path, settings, run);

/** Runs `run` with the claim held, and checks nothing runs without it. */
const expectClaimRefused = async (
  path: string,
  settings = SETTINGS,
): Promise<void> => {
  let ranAnyway = false;
  await expect(
    withTestClaim(
      path,
      () => {
        ranAnyway = true;
        return Promise.resolve();
      },
      settings,
    ),
  ).rejects.toThrow("Timed out waiting for the test claim");
  expect(ranAnyway).toBe(false);
};

/** Hold the test claim until told to let go, resolving once it is really
 * held — so a clock or waiter driven meanwhile is genuinely mid-hold. */
const holdClaimUntilReleased = async (
  path: string,
  settings = SETTINGS,
): Promise<{ holding: Promise<void>; release: () => void }> => {
  const taken = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const holding = withTestClaim(
    path,
    () => {
      taken.resolve();
      return released.promise;
    },
    settings,
  );
  await taken.promise;
  return { holding, release: () => released.resolve() };
};

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

/** Real time's setTimeout, taken before any test puts a fake clock in. */
const REAL_SET_TIMEOUT = setTimeout;

/** A real-time pause, for waits a fake clock must not intercept — letting a
 * file write that has already started reach the disk. */
const settle = (): Promise<void> =>
  new Promise((resolve) => REAL_SET_TIMEOUT(resolve, 5));

/** Step the fake clock, letting each touch settle before the next fires. */
const tickBy = async (time: FakeTime, ...steps: number[]): Promise<void> => {
  for (const step of steps) await time.tickAsync(step);
};

type FakeHold = {
  held: Awaited<ReturnType<typeof holdClaimUntilReleased>>;
  time: FakeTime;
};

/** Hold the claim with a 30ms stale window, on a clock the test drives.
 * Dispose the clock with `using` at the call site. */
const holdOnFakeClock = async (
  path: string,
  touchMs = 10,
): Promise<FakeHold> => {
  const time = new FakeTime();
  const held = await holdClaimUntilReleased(path, {
    ...SETTINGS,
    staleMs: 30,
    touchMs,
  });
  return { held, time };
};

describe("keeping a claim fresh while it is held", () => {
  test("touches the claim on time, so it never reads as walked away", async () => {
    await withClaimDir(async (path) => {
      const { held, time } = await holdOnFakeClock(path, 5);
      using _clock = time;
      // Two rounds, so the touch after a touch is proven too — not just the
      // first one armed when the claim was taken.
      for (let round = 0; round < 2; round += 1) {
        // Age the record as if the holder had stalled for a long while.
        await writeClaim(path, `kept\n${Date.now() - 40}`);
        expect(await claimIsFresh(path, 25)).toBe(false);

        await time.tickAsync(5);
        await settle();

        expect(await claimIsFresh(path, 25)).toBe(true);
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
      const holding = held.holding.then(() => {
        released = true;
      });
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
      for (const touch of lateTouches) touch();

      // Real time for the wrongly started write to land, if there was one.
      await settle();
      await expect(Deno.stat(path)).rejects.toThrow();
    });
  });
});

/** Break every touch of `path` while `stillFailing` says so. The very first
 * write — the one that creates the claim — always goes through. */
const failClaimTouches = (
  path: string,
  stillFailing: () => boolean,
): Disposable => {
  const writeTextFile = Deno.writeTextFile;
  let writes = 0;
  return stub(Deno, "writeTextFile", ((
    target: string | URL,
    data: string | ReadableStream<string>,
    options?: Deno.WriteFileOptions,
  ) => {
    if (`${target}` === path) {
      writes += 1;
      if (writes > 1 && stillFailing()) {
        return Promise.reject(new Error("the disk went read-only"));
      }
    }
    return writeTextFile(target, data, options);
  }) as typeof Deno.writeTextFile);
};

/** End the hold, expecting the holder to hear its claim was let go stale. */
const expectHoldLostFreshness = (held: FakeHold["held"]): Promise<void> => {
  held.release();
  return expect(held.holding).rejects.toThrow("could not be kept fresh");
};

/** Hold the claim while its touches fail, on a clock the scenario drives;
 * calling `recover` lets touches land again from then on. */
const holdWhileTouchesFail = async (
  path: string,
  scenario: (context: {
    held: Awaited<ReturnType<typeof holdClaimUntilReleased>>;
    recover: () => void;
    time: FakeTime;
  }) => Promise<void>,
  touchMs?: number,
): Promise<void> => {
  let recovered = false;
  using _write = failClaimTouches(path, () => !recovered);
  const { held, time } = await holdOnFakeClock(path, touchMs);
  using _clock = time;
  await scenario({
    held,
    recover: () => {
      recovered = true;
    },
    time,
  });
};

describe("a holder whose touches stop landing", () => {
  test("hears about it once the touches have failed for a whole stale window", async () => {
    await withClaimDir((path) =>
      holdWhileTouchesFail(path, async ({ held, time }) => {
        // Failures at 10, 20, 30 and 40ms: by the last one the record has
        // gone unwritten for the whole 30ms window, so for anyone reading
        // the file the holder walked away — the work cannot end quietly.
        await tickBy(time, 10, 10, 10, 10);

        await expectHoldLostFreshness(held);
      }),
    );
  });

  test("hears about it even when the touches recover too late", async () => {
    await withClaimDir((path) =>
      holdWhileTouchesFail(path, async ({ held, recover, time }) => {
        // The outage spanned the window, so the claim may already be
        // somebody else's; a touch landing afterwards cannot unhappen that.
        await tickBy(time, 10, 10, 10, 10);
        recover();
        await tickBy(time, 10);

        await expectHoldLostFreshness(held);
      }),
    );
  });

  test("hears about it when the hold ends mid-outage spanning the window", async () => {
    await withClaimDir((path) =>
      holdWhileTouchesFail(
        path,
        async ({ held, time }) => {
          // Failures at 20 and 40ms, then 19ms more of silence: 39ms since
          // the record was last written, with no touch left to notice —
          // only the release can tell the claim was let go stale.
          await tickBy(time, 20, 20, 19);

          await expectHoldLostFreshness(held);
        },
        20,
      ),
    );
  });

  test("carries on past a failed touch, touching again so the blip heals", async () => {
    await withClaimDir((path) =>
      holdWhileTouchesFail(path, async ({ held, recover, time }) => {
        await tickBy(time, 10);
        recover();
        await tickBy(time, 10, 5);
        await settle();

        // Touched again after the blip: fresh, judged against a window far
        // smaller than the time since the claim was first written.
        expect(await claimIsFresh(path, 12)).toBe(true);
        held.release();
        await held.holding;
      }),
    );
  });
});

describe("keeping somebody else's claim fresh for them", () => {
  test("touches it from the very first moment, keeping their name on it", async () => {
    await withClaimDir(async (path) => {
      await writeClaim(path, `their-supervisor\n${LONG_AGO_MS}`);

      const stopTouching = await keepClaimFresh(path, {
        staleMs: FRESH_FOR_MS,
        touchMs: FRESH_FOR_MS,
      });
      expect(await claimIsFresh(path, FRESH_FOR_MS)).toBe(true);
      await stopTouching();

      // Stopping never removes the claim: it stays theirs to release.
      expect(
        (await Deno.readTextFile(path)).startsWith("their-supervisor"),
      ).toBe(true);
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

describe("releasing a claim", () => {
  test("removes the claim so the next taker finds it free", async () => {
    await withClaimDir(async (path) => {
      await withTestClaim(path, () => Promise.resolve());

      await expect(Deno.stat(path)).rejects.toThrow();
      await withTestClaim(path, () => Promise.resolve());
    });
  });

  test("leaves a claim that has since become somebody else's", async () => {
    await withClaimDir(async (path) => {
      await withTestClaim(path, () =>
        writeClaim(path, `new-owner\n${Date.now()}`),
      );

      expect((await Deno.readTextFile(path)).startsWith("new-owner")).toBe(
        true,
      );
    });
  });

  test("says nothing when the claim is already gone", async () => {
    await withClaimDir(async (path) => {
      await withTestClaim(path, () => Deno.remove(path));

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
