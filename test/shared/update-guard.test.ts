import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { waitForUpdatePage } from "#shared/update-guard.ts";
import { fakeClock, page } from "#test-utils/_shared-site-update.ts";
import { MOCK_RELEASE } from "#test-utils/mocks.ts";

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

  test("an immediately ready build fetches without a sleep", async () => {
    // The ordinary wait's first check is immediate: a zero gap is a real
    // no-sleep path, so the wake-up fetch must not wait on a timer.
    let sleeps = 0;
    await waitForUpdatePage({
      fetchPage: () => Promise.resolve(page("active", MOCK_RELEASE.tag_name)),
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    expect(sleeps).toBe(0);
  });

  test("a not-ready then ready wait sleeps once between its fetches", async () => {
    const pages = [page("supported"), page("active", MOCK_RELEASE.tag_name)];
    let fetches = 0;
    let sleeps = 0;
    await waitForUpdatePage({
      fetchPage: () => Promise.resolve(pages[fetches++]!),
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    expect(fetches).toBe(2);
    expect(sleeps).toBe(1);
  });

  test("a ready page at the deadline still succeeds", async () => {
    // The check that lands on the deadline decides before any run-out: the
    // deadline is only consulted after a check that still finds the page
    // unchanged. Thirty-six quiet gaps put the 37th check on the deadline.
    const clock = fakeClock();
    const pages = [
      ...Array.from({ length: 36 }, () => page("supported")),
      page("active", MOCK_RELEASE.tag_name),
    ];
    let fetches = 0;
    await waitForUpdatePage({
      fetchPage: () => Promise.resolve(pages[fetches++]!),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(fetches).toBe(37);
    expect(clock.now()).toBe(180_000);
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

  test("ends the wait on the first failed page fetch", async () => {
    let fetches = 0;
    let sleeps = 0;
    const error = await waitForUpdatePage({
      fetchPage: () => {
        fetches += 1;
        // The user's failing run: the site's host did not resolve, so no
        // later check can answer better than this one.
        return Promise.reject(
          new TypeError(
            "error sending request for url (https://null/read-only): client error (Connect): dns error: failed to lookup address information: Temporary failure in name resolution",
          ),
        );
      },
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    }).catch((caught: unknown) => caught);
    // One immediate check, then the abort: no quiet-gap retries, no
    // deadline run-out.
    expect(fetches).toBe(1);
    expect(sleeps).toBe(0);
    expect((error as Error).message).toMatch(
      /The last page check failed: error sending request for url \(https:\/\/null\/read-only\)/,
    );
    expect((error as Error).message).toMatch(/UPDATE_IN_PROGRESS is still set/);
    expect((error as Error).message).not.toMatch(/within 180 seconds/);
  });

  test("an abort names a failure that is not an Error", async () => {
    await expect(
      waitForUpdatePage({
        fetchPage: () => Promise.reject("boom"),
        now: fakeClock().now,
        sleep: fakeClock().sleep,
      }),
    ).rejects.toThrow(/The last page check failed: boom/);
  });

  test("a failed fetch aborts instead of the unsupported skip", async () => {
    let fetches = 0;
    await expect(
      waitForUpdatePage({
        fetchPage: () => {
          fetches += 1;
          return Promise.reject(new Error("network down"));
        },
        now: fakeClock().now,
        skipWhenUnsupported: true,
        sleep: fakeClock().sleep,
      }),
    ).rejects.toThrow(/The last page check failed: network down/);
    expect(fetches).toBe(1);
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
