import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runUnderUpdateGuard,
  UPDATE_FLAG_VALUE,
  type UpdateGuardIo,
  waitForBeginPropagation,
} from "#shared/update-guard.ts";
import {
  fakeClock,
  page,
  recordingUpdateGuard,
} from "#test-utils/_shared-site-update.ts";
import { MOCK_RELEASE } from "#test-utils/mocks.ts";

/** A guard io on a stepped clock that records every operation and answers
 * every page fetch with `served`. */
const clockGuardIo = (
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  served: string,
  calls: string[],
): UpdateGuardIo => ({
  clearFlag: async () => {
    calls.push("clear");
  },
  fetchPage: () => {
    calls.push("fetch");
    return Promise.resolve(served);
  },
  now: clock.now,
  setFlag: async (value) => {
    calls.push(`set:${value}`);
  },
  sleep: clock.sleep,
});

/** Run a begin wait whose every page check fails with `failure`, on a
 * stepped clock. Returns the caught error, the check marks, the log lines,
 * the revert count, and the clock, so each abort test pins its own slice. */
const failedBeginWait = async (
  failure: () => Promise<string>,
  revert: () => Promise<void> = () => Promise.resolve(),
): Promise<{
  clock: ReturnType<typeof fakeClock>;
  error: unknown;
  marks: number[];
  reverts: number;
  seen: string[];
}> => {
  const clock = fakeClock();
  const marks: number[] = [];
  const seen: string[] = [];
  let reverts = 0;
  const error = await waitForBeginPropagation(
    {
      fetchPage: () => {
        marks.push(clock.now());
        return failure();
      },
      log: (message) => seen.push(message),
      now: clock.now,
      skipWhenUnsupported: true,
      sleep: clock.sleep,
    },
    () => {
      reverts += 1;
      return revert();
    },
  ).catch((caught: unknown) => caught);
  return { clock, error, marks, reverts, seen };
};

describe("waitForBeginPropagation", () => {
  test("checks at the 10, 30, and 60 second marks and reverts on a run-out", async () => {
    const { error, marks, reverts, seen } = await failedBeginWait(() =>
      Promise.resolve(page("supported")),
    );
    // Three single checks after quiet gaps: no check at t=0, no polling
    // between the marks.
    expect(marks).toEqual([10_000, 30_000, 60_000]);
    expect(reverts).toBe(1);
    expect(seen).toEqual([
      "The site still does not show its update page 10 seconds after the flag was set.",
      "The site still does not show its update page 30 seconds after the flag was set.",
      "The site still does not show its update page 60 seconds after the flag was set.",
    ]);
    expect((error as Error).message).toMatch(
      /The flag was removed, so the site accepts writes again/,
    );
  });

  test("an update page at any mark ends the wait cleanly", async () => {
    const clock = fakeClock();
    const marks: number[] = [];
    let reverts = 0;
    await waitForBeginPropagation(
      {
        fetchPage: () => {
          marks.push(clock.now());
          return Promise.resolve(
            marks.length === 1 ? page("supported") : page("active"),
          );
        },
        now: clock.now,
        skipWhenUnsupported: true,
        sleep: clock.sleep,
      },
      () => {
        reverts += 1;
        return Promise.resolve();
      },
    );
    expect(marks).toEqual([10_000, 30_000]);
    expect(reverts).toBe(0);
  });

  test("reports a removal failure alongside the run-out", async () => {
    const { error } = await failedBeginWait(
      () => Promise.resolve(page("supported")),
      () => Promise.reject(new Error("the delete failed")),
    );
    expect((error as Error).message).toMatch(/within 60 seconds/);
    expect((error as Error).message).toMatch(
      /Removing the flag failed: the delete failed, so UPDATE_IN_PROGRESS may still be set/,
    );
  });

  test("a failed first check aborts the begin wait before the later marks", async () => {
    // The user's failing run: the site's host did not resolve, and the old
    // schedule repeated that failure at every mark for a minute before it
    // gave up.
    const { clock, error, marks, reverts, seen } = await failedBeginWait(() =>
      Promise.reject(
        new TypeError(
          "error sending request for url (https://null/read-only): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution",
        ),
      ),
    );
    // One check at the 10 second mark, then the abort: the 30 and 60
    // second marks never elapse, no run-out message appears, and the
    // revert happened before the error left the wait.
    expect(marks).toEqual([10_000]);
    expect(clock.now()).toBe(10_000);
    expect(seen).toEqual([]);
    expect(reverts).toBe(1);
    expect((error as Error).message).toMatch(
      /The last page check failed: error sending request for url \(https:\/\/null\/read-only\)/,
    );
    expect((error as Error).message).toMatch(
      /The flag was removed, so the site accepts writes again/,
    );
    expect((error as Error).message).not.toMatch(/within 60 seconds/);
  });

  test("a failed check's abort reports a removal failure alongside", async () => {
    const { error } = await failedBeginWait(
      () => Promise.reject(new Error("network down")),
      () => Promise.reject(new Error("the delete failed")),
    );
    expect((error as Error).message).toMatch(
      /Removing the flag failed: the delete failed, so UPDATE_IN_PROGRESS may still be set/,
    );
    expect((error as Error).message).toMatch(
      /The last page check failed: network down/,
    );
    expect((error as Error).message).not.toMatch(/within 60 seconds/);
  });

  test("skips a build that predates update mode", async () => {
    const { clock, reverts } = await failedBeginWait(() =>
      Promise.resolve(page("unsupported")),
    );
    expect(clock.now()).toBe(10_000);
    expect(reverts).toBe(0);
  });
});

describe("runUnderUpdateGuard", () => {
  test("sets the flag, deploys, confirms the new build, and lifts", async () => {
    const clock = fakeClock();
    const { calls, io } = recordingUpdateGuard(
      [
        page("active", "v2026-01-01-000000"),
        page("active", MOCK_RELEASE.tag_name),
      ],
      { now: clock.now, sleep: clock.sleep },
    );
    const result = await runUnderUpdateGuard(
      io,
      async () => {
        calls.push("deploy");
        return "done";
      },
      () => MOCK_RELEASE.tag_name,
    );
    expect(result).toBe("done");
    expect(calls).toEqual(["set:1", "fetch", "deploy", "fetch", "clear"]);
    expect(calls[0]).toBe(`set:${UPDATE_FLAG_VALUE}`);
  });

  test("skips the first wait for a build that predates update mode", async () => {
    const clock = fakeClock();
    const { calls, io } = recordingUpdateGuard(
      [page("unsupported"), page("active", MOCK_RELEASE.tag_name)],
      { now: clock.now, sleep: clock.sleep },
    );
    await runUnderUpdateGuard(
      io,
      async () => {
        calls.push("deploy");
      },
      () => MOCK_RELEASE.tag_name,
    );
    expect(calls).toEqual(["set:1", "fetch", "deploy", "fetch", "clear"]);
  });

  test("keeps the flag while the old build answers after publish", async () => {
    // The old build serves its update page after publish and names no
    // expected build, so the guard must not lift the flag for it. The page
    // fetch never stops answering with that old build.
    const clock = fakeClock();
    const calls: string[] = [];
    const io = clockGuardIo(clock, page("active"), calls);
    await expect(
      runUnderUpdateGuard(
        io,
        async () => {
          calls.push("deploy");
        },
        () => MOCK_RELEASE.tag_name,
      ),
    ).rejects.toThrow(/the deploy expected v2099-01-01-120000/);
    // The wait polls the old build to its deadline; the flag never lifts.
    expect(calls.filter((call) => call !== "fetch")).toEqual([
      "set:1",
      "deploy",
    ]);
  });

  test("leaves the flag set when the deploy throws", async () => {
    const clock = fakeClock();
    const { calls, io } = recordingUpdateGuard([page("active")], {
      now: clock.now,
      sleep: clock.sleep,
    });
    await expect(
      runUnderUpdateGuard(
        io,
        () => Promise.reject(new Error("upload failed")),
        () => MOCK_RELEASE.tag_name,
      ),
    ).rejects.toThrow("upload failed");
    expect(calls).toEqual(["set:1", "fetch"]);
  });

  test("reverts the flag when the begin marks pass with the site unchanged", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const io = clockGuardIo(clock, page("supported"), calls);
    await expect(
      runUnderUpdateGuard(
        io,
        async () => {
          calls.push("deploy");
        },
        () => MOCK_RELEASE.tag_name,
      ),
    ).rejects.toThrow(/The flag was removed, so the site accepts writes again/);
    // Three checks, then the revert; the deploy body never ran.
    expect(calls).toEqual(["set:1", "fetch", "fetch", "fetch", "clear"]);
  });

  test("leaves the flag set when the lift fails", async () => {
    const clock = fakeClock();
    const calls: string[] = [];
    const io: UpdateGuardIo = {
      clearFlag: () => {
        calls.push("clear");
        return Promise.reject(new Error("bunny api down"));
      },
      fetchPage: () => {
        calls.push("fetch");
        return Promise.resolve(page("active", MOCK_RELEASE.tag_name));
      },
      now: clock.now,
      setFlag: async (value) => {
        calls.push(`set:${value}`);
      },
      sleep: clock.sleep,
    };
    await expect(
      runUnderUpdateGuard(
        io,
        async () => {
          calls.push("deploy");
        },
        () => MOCK_RELEASE.tag_name,
      ),
    ).rejects.toThrow("bunny api down");
    expect(calls).toEqual(["set:1", "fetch", "deploy", "fetch", "clear"]);
  });
});
