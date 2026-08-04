/**
 * Shared fixtures for the stale-claim suites: quick one-try settings, claim
 * files written as other holders leave them, and clocks the tests drive.
 */

import { join } from "node:path";
// Real time's setTimeout: node's own binding, which a fake clock stubbed onto
// globalThis never touches.
import { setTimeout as realSetTimeout } from "node:timers";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { withClaim } from "#scripts/stale-claim.ts";
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

/** Work with nothing to observe, for tests about the claim alone. */
const doNothing = (): Promise<void> => Promise.resolve();

/** Tries to take the held claim, and checks the holder's record survives. */
const expectClaimRefused = async (
  path: string,
  settings = SETTINGS,
): Promise<void> => {
  const holdersRecord = await Deno.readTextFile(path);
  await expect(withTestClaim(path, doNothing, settings)).rejects.toThrow(
    "Timed out waiting for the test claim",
  );
  // Had the work run, its release would have removed or replaced the record.
  expect(await Deno.readTextFile(path)).toBe(holdersRecord);
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

/** Runs `look` at every read of the claim at `path`. A record handed back is
 * what that one read sees; null lets the real file answer. */
const watchClaimReads = (
  path: string,
  look: () => string | null,
): Disposable => {
  const readTextFile = Deno.readTextFile;
  return stub(Deno, "readTextFile", ((
    target: string | URL,
    options?: Deno.ReadFileOptions,
  ) => {
    if (`${target}` === path) {
      const standIn = look();
      if (standIn !== null) return Promise.resolve(standIn);
    }
    return readTextFile(target, options);
  }) as typeof Deno.readTextFile);
};

/** Count every look at the claim at `path`, letting the reads go through. */
const countClaimReads = (
  path: string,
  counter: { reads: number },
): Disposable =>
  watchClaimReads(path, () => {
    counter.reads += 1;
    return null;
  });

/** A real-time pause, for waits a fake clock must not intercept — letting a
 * file write that has already started reach the disk. */
const settle = (): Promise<void> =>
  new Promise((resolve) => realSetTimeout(resolve, 5));

/** Step the fake clock, letting each touch settle before the next fires. */
const tickBy = async (time: FakeTime, ...steps: number[]): Promise<void> => {
  for (const step of steps) {
    await time.tickAsync(step);
    // A touch is a guarded read-then-write of real files; give it real
    // event-loop time to land before the clock moves on.
    await settle();
  }
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

/** Hold the claim on a fake clock, then let a taker's record land over it.
 * Dispose the clock with `using` at the call site. */
const holdThenLoseClaim = async (
  path: string,
  touchMs?: number,
): Promise<FakeHold & { takenRecord: string }> => {
  const { held, time } = await holdOnFakeClock(path, touchMs);
  await writeClaim(path, `new-owner\n${Date.now()}`);
  return { held, takenRecord: await Deno.readTextFile(path), time };
};

/** Wait, in real time, for the look to say yes — for a write already on its
 * way to the disk. Gives up loudly rather than waiting for ever. */
const eventually = async (
  look: () => Promise<boolean>,
  attempts = 400,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await look()) return;
    await settle();
  }
  throw new Error("The looked-for state never arrived.");
};

export {
  ageFile,
  countClaimReads,
  doNothing,
  eventually,
  expectClaimRefused,
  type FakeHold,
  FRESH_FOR_MS,
  failClaimTouches,
  holdClaimUntilReleased,
  holdOnFakeClock,
  holdThenLoseClaim,
  holdWhileTouchesFail,
  LONG_AGO_MS,
  SETTINGS,
  settle,
  tickBy,
  watchClaimReads,
  withClaimDir,
  withTestClaim,
  writeClaim,
};
