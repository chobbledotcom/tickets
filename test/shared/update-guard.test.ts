import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  runUnderUpdateGuard,
  UPDATE_FLAG_VALUE,
  type UpdateGuardIo,
  updateBuildTagMeta,
  updatePageBuildTag,
  updatePageMeta,
  updatePageState,
  waitForUpdatePage,
} from "#shared/update-guard.ts";
import { recordingUpdateGuard } from "#test-utils/_shared-site-update.ts";
import { MOCK_RELEASE } from "#test-utils/mocks.ts";

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

const page = (
  state: "unsupported" | "supported" | "active",
  buildTag?: string,
): string => {
  if (state === "unsupported") return "<html><head></head></html>";
  const tag = buildTag === undefined ? "" : updateBuildTagMeta(buildTag);
  return `<html><head>${updatePageMeta(state)}${tag}</head></html>`;
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

  test("reads the build tag the page reports", () => {
    expect(updatePageBuildTag(page("active", "v2026-03-28-143022"))).toBe(
      "v2026-03-28-143022",
    );
    expect(updatePageBuildTag(page("active"))).toBeNull();
    expect(updatePageBuildTag("")).toBeNull();
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

  test("keeps polling while only the old build answers active", async () => {
    // The exact post-deploy race: the old build still serves its update page
    // after publish, so an active page without the expected tag must not
    // pass the wait.
    const pages = [
      page("active"),
      page("active", "v2026-01-01-000000"),
      page("active", MOCK_RELEASE.tag_name),
    ];
    let fetches = 0;
    await waitForUpdatePage({
      expectedBuildTag: MOCK_RELEASE.tag_name,
      fetchPage: () => Promise.resolve(pages[fetches++]!),
      sleep: () => Promise.resolve(),
    });
    expect(fetches).toBe(3);
  });

  test("refuses an active page that reports no build tag", async () => {
    const clock = fakeClock();
    await expect(
      waitForUpdatePage({
        expectedBuildTag: MOCK_RELEASE.tag_name,
        fetchPage: () => Promise.resolve(page("active")),
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(
      /a build that reports no build tag, but the deploy expected v2099-01-01-120000/,
    );
  });

  test("names the build that kept answering the update page", async () => {
    const clock = fakeClock();
    await expect(
      waitForUpdatePage({
        expectedBuildTag: MOCK_RELEASE.tag_name,
        fetchPage: () => Promise.resolve(page("active", "v2026-01-01-000000")),
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(
      /answered from build v2026-01-01-000000, but the deploy expected v2099-01-01-120000/,
    );
  });
});

describe("runUnderUpdateGuard", () => {
  test("sets the flag, deploys, confirms the new build, and lifts", async () => {
    const { calls, io } = recordingUpdateGuard([
      page("active", "v2026-01-01-000000"),
      page("active", MOCK_RELEASE.tag_name),
    ]);
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
    const { calls, io } = recordingUpdateGuard([
      page("unsupported"),
      page("active", MOCK_RELEASE.tag_name),
    ]);
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
    const io: UpdateGuardIo = {
      clearFlag: async () => {
        calls.push("clear");
      },
      fetchPage: () => {
        calls.push("fetch");
        return Promise.resolve(page("active"));
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
    ).rejects.toThrow(/the deploy expected v2099-01-01-120000/);
    // The wait polls the old build to its deadline; the flag never lifts.
    expect(calls.filter((call) => call !== "fetch")).toEqual([
      "set:1",
      "deploy",
    ]);
  });

  test("leaves the flag set when the deploy throws", async () => {
    const { calls, io } = recordingUpdateGuard([page("active")]);
    await expect(
      runUnderUpdateGuard(
        io,
        () => Promise.reject(new Error("upload failed")),
        () => MOCK_RELEASE.tag_name,
      ),
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
        return Promise.resolve(page("active", MOCK_RELEASE.tag_name));
      },
      setFlag: async (value) => {
        calls.push(`set:${value}`);
      },
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
