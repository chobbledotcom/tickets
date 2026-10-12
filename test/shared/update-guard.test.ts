import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runUnderUpdateGuard,
  UPDATE_FLAG_VALUE,
  type UpdateGuardIo,
  updatePageMeta,
  updatePageState,
  waitForUpdatePage,
} from "#shared/update-guard.ts";

/** A wait clock the tests step forward on every sleep, so a timed-out wait
 * needs no real delay. */
const fakeClock = (): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
};

const page = (state: "unsupported" | "supported" | "active"): string => {
  if (state === "unsupported") return "<html><head></head></html>";
  return `<html><head>${updatePageMeta(state)}</head></html>`;
};

describe("update page marker", () => {
  test("reads active, supported, and unsupported pages", () => {
    expect(updatePageState(page("active"))).toBe("active");
    expect(updatePageState(page("supported"))).toBe("supported");
    expect(updatePageState(page("unsupported"))).toBe("unsupported");
    expect(updatePageState("")).toBe("unsupported");
  });

  test("does not read a foreign content value as active", () => {
    expect(
      updatePageState(
        '<meta name="update-in-progress" content="supported"><meta name="x" content="active">',
      ),
    ).toBe("supported");
  });
});

describe("waitForUpdatePage", () => {
  test("returns as soon as the update page shows", async () => {
    const pages = [page("supported"), page("supported"), page("active")];
    let fetches = 0;
    await waitForUpdatePage({
      fetchPage: () => Promise.resolve(pages[fetches++]!),
      now: fakeClock().now,
      sleep: () => Promise.resolve(),
    });
    expect(fetches).toBe(3);
  });

  test("skips a build that predates update mode when asked to", async () => {
    const seen: string[] = [];
    await waitForUpdatePage({
      fetchPage: () => Promise.resolve(page("unsupported")),
      log: (message) => seen.push(message),
      skipWhenUnsupported: true,
    });
    expect(seen.length).toBe(1);
  });

  test("keeps polling an unsupported build after the deploy", async () => {
    // After the deploy, "unsupported" means the old build still serves, so
    // the wait must not skip it.
    const pages = [page("unsupported"), page("active")];
    let fetches = 0;
    await waitForUpdatePage({
      fetchPage: () => Promise.resolve(pages[fetches++]!),
      sleep: () => Promise.resolve(),
    });
    expect(fetches).toBe(2);
  });

  test("throws with the operator instruction when the wait runs out", async () => {
    const clock = fakeClock();
    await expect(
      waitForUpdatePage({
        fetchPage: () => Promise.resolve(page("supported")),
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/UPDATE_IN_PROGRESS is still set/);
  });

  test("a failed page fetch keeps the wait polling", async () => {
    const pages: (string | Error)[] = [
      new Error("network down"),
      page("active"),
    ];
    let fetches = 0;
    await waitForUpdatePage({
      fetchPage: () => {
        const next = pages[fetches++]!;
        return next instanceof Error
          ? Promise.reject(next)
          : Promise.resolve(next);
      },
      sleep: () => Promise.resolve(),
    });
    expect(fetches).toBe(2);
  });

  test("a run-out names the last page check failure", async () => {
    const clock = fakeClock();
    await expect(
      waitForUpdatePage({
        fetchPage: () => Promise.reject(new Error("HTTP 503")),
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/The last page check failed: HTTP 503/);
  });

  test("a run-out names a failure that is not an Error", async () => {
    const clock = fakeClock();
    await expect(
      waitForUpdatePage({
        fetchPage: () => Promise.reject("boom"),
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/The last page check failed: boom/);
  });

  test("a failed fetch never triggers the unsupported skip", async () => {
    const clock = fakeClock();
    await expect(
      waitForUpdatePage({
        fetchPage: () => Promise.reject(new Error("network down")),
        now: clock.now,
        skipWhenUnsupported: true,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/UPDATE_IN_PROGRESS is still set/);
  });
});

const recordingIo = (
  pages: string[],
): { calls: string[]; io: UpdateGuardIo } => {
  const calls: string[] = [];
  return {
    calls,
    io: {
      clearFlag: async () => {
        calls.push("clear");
      },
      fetchPage: () => {
        calls.push("fetch");
        return Promise.resolve(
          pages[calls.filter((c) => c === "fetch").length - 1] ??
            page("active"),
        );
      },
      setFlag: async (value) => {
        calls.push(`set:${value}`);
      },
    },
  };
};

describe("runUnderUpdateGuard", () => {
  test("sets the flag, deploys, confirms the new build, and lifts", async () => {
    const { calls, io } = recordingIo([page("active"), page("active")]);
    const result = await runUnderUpdateGuard(io, async () => {
      calls.push("deploy");
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toEqual(["set:1", "fetch", "deploy", "fetch", "clear"]);
    expect(calls[0]).toBe(`set:${UPDATE_FLAG_VALUE}`);
  });

  test("skips the first wait for a build that predates update mode", async () => {
    const { calls, io } = recordingIo([page("unsupported"), page("active")]);
    await runUnderUpdateGuard(io, async () => {
      calls.push("deploy");
    });
    expect(calls).toEqual(["set:1", "fetch", "deploy", "fetch", "clear"]);
  });

  test("leaves the flag set when the deploy throws", async () => {
    const { calls, io } = recordingIo([page("active")]);
    await expect(
      runUnderUpdateGuard(io, () => Promise.reject(new Error("upload failed"))),
    ).rejects.toThrow("upload failed");
    expect(calls).toEqual(["set:1", "fetch"]);
  });

  test("leaves the flag set when the lift fails", async () => {
    const calls: string[] = [];
    const io: UpdateGuardIo = {
      clearFlag: () => {
        calls.push("clear");
        return Promise.reject(new Error("bunny api down"));
      },
      fetchPage: () => {
        calls.push("fetch");
        return Promise.resolve(page("active"));
      },
      setFlag: async (value) => {
        calls.push(`set:${value}`);
      },
    };
    await expect(
      runUnderUpdateGuard(io, async () => {
        calls.push("deploy");
      }),
    ).rejects.toThrow("bunny api down");
    expect(calls).toEqual(["set:1", "fetch", "deploy", "fetch", "clear"]);
  });
});
