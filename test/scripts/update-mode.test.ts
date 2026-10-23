import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { FetchText, FetchTextResult } from "#scripts/fetch-text.ts";
import { runUpdateMode, type UpdateModeIo } from "#scripts/update-mode-lib.ts";
import { updateBuildTagMeta, updatePageMeta } from "#shared/update-guard.ts";

const UPDATE_SECRET_URL = "https://api.bunny.net/compute/script/42/secrets";
const READ_ONLY_URL = "https://site.example/read-only";

/** The release tag the end command pins the wait to. */
const END_BUILD_TAG = "v2099-01-01-120000";

const response = (
  ok: boolean,
  status: number,
  text: string,
): FetchTextResult => ({
  ok,
  status,
  text,
});

/** A fetch stub that answers Bunny API calls from `apiResponses` in order and
 * page fetches from `pages`, recording every call. An exhausted page list
 * repeats its last entry, so a wait that polls "forever" never advances. */
const stubFetch = (
  apiResponses: FetchTextResult[],
  pages: string[],
): { calls: { init: RequestInit; url: string }[]; fetchText: FetchText } => {
  const calls: { init: RequestInit; url: string }[] = [];
  let apiCalls = 0;
  let pageCalls = 0;
  const fetchText: FetchText = (url, init) => {
    calls.push({ init, url });
    if (url === READ_ONLY_URL) {
      const next = pages[pageCalls++] ?? pages[pages.length - 1] ?? activePage;
      return Promise.resolve(response(true, 200, next));
    }
    return Promise.resolve(apiResponses[apiCalls++] ?? response(true, 204, ""));
  };
  return { calls, fetchText };
};

const io = (
  fetchText: FetchText,
  overrides: Partial<UpdateModeIo> = {},
): UpdateModeIo => ({
  accessKey: "key",
  fetchText,
  log: () => {},
  sleep: () => Promise.resolve(),
  ...overrides,
});

/** Run one begin command on a stepped clock and return the caught error
 * with the clock's end time. */
const beginOnClock = async (
  fetchText: FetchText,
): Promise<{ error: unknown; time: number }> => {
  let time = 0;
  const error = await runUpdateMode(["begin", "42", "https://site.example"], {
    accessKey: "key",
    fetchText,
    log: () => {},
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  }).catch((caught: unknown) => caught);
  return { error, time };
};

const activePage = `<html><head>${updatePageMeta("active")}${updateBuildTagMeta(END_BUILD_TAG)}</head></html>`;
// A build from before the wait pinned the build tag: it answers active but
// names no build.
const oldBuildActivePage = `<html><head>${updatePageMeta("active")}</head></html>`;
const supportedPage = `<html><head>${updatePageMeta("supported")}</head></html>`;
const plainPage = "<html><head></head></html>";

describe("runUpdateMode", () => {
  /** Run one command line and expect the usage line and exit code 1.
   * Returns the recorded calls so a test can pin what the command did not
   * do. */
  const expectUsage = async (
    args: string[],
  ): Promise<{ calls: { init: RequestInit; url: string }[] }> => {
    const logged: string[] = [];
    const { calls, fetchText } = stubFetch([], []);
    const code = await runUpdateMode(args, {
      accessKey: "key",
      fetchText,
      log: (line) => logged.push(line),
    });
    expect(code).toBe(1);
    assertStringIncludes(logged.join("\n"), "Usage:");
    return { calls };
  };

  test("rejects an unknown command with the usage line", async () => {
    await expectUsage(["lift", "42", "https://site.example"]);
  });

  test("end rejects a missing build tag with the usage line", async () => {
    const { calls } = await expectUsage(["end", "42", "https://site.example"]);
    expect(calls).toEqual([]);
  });

  test("begin sets the flag, then waits for the update page", async () => {
    const { calls, fetchText } = stubFetch(
      [response(true, 204, "")],
      [plainPage, activePage],
    );
    const code = await runUpdateMode(
      ["begin", "42", "https://site.example"],
      io(fetchText),
    );
    expect(code).toBe(0);
    const [setCall, pageCall] = calls;
    expect(setCall?.url).toBe(UPDATE_SECRET_URL);
    expect(setCall?.init.method).toBe("PUT");
    expect(JSON.parse(setCall?.init.body as string)).toEqual({
      Name: "UPDATE_IN_PROGRESS",
      Secret: "1",
    });
    expect(setCall?.init.headers).toEqual({
      AccessKey: "key",
      "Content-Type": "application/json",
    });
    expect(pageCall?.url).toBe(READ_ONLY_URL);
    expect(calls.length).toBe(2);
  });

  test("the page fetch carries an abort timeout so a stall cannot wedge the wait", async () => {
    const { calls, fetchText } = stubFetch(
      [response(true, 204, "")],
      [activePage],
    );
    await runUpdateMode(["begin", "42", "https://site.example"], io(fetchText));
    const [setCall, pageCall] = calls;
    // The page fetch must end on its own before the wait's deadline, or a
    // stalled connection keeps the command pending forever.
    expect(pageCall?.init.signal).toBeInstanceOf(AbortSignal);
    // Only the page fetch is bounded; the Bunny API calls keep no signal.
    expect(setCall?.init.signal).toBeUndefined();
  });

  test("begin skips the wait for a build that predates update mode", async () => {
    const { calls, fetchText } = stubFetch(
      [response(true, 204, "")],
      [plainPage],
    );
    const code = await runUpdateMode(
      ["begin", "42", "https://site.example"],
      io(fetchText),
    );
    expect(code).toBe(0);
    expect(calls.length).toBe(2);
  });

  test("begin removes the flag when the site never goes read-only", async () => {
    const { calls, fetchText } = stubFetch(
      [
        response(true, 204, ""),
        response(
          true,
          200,
          '{"Secrets":[{"Id":7,"Name":"UPDATE_IN_PROGRESS"}]}',
        ),
        response(true, 204, ""),
      ],
      [supportedPage],
    );
    const { error, time } = await beginOnClock(fetchText);
    expect((error as Error).message).toMatch(
      /The flag was removed, so the site accepts writes again/,
    );
    expect((error as Error).message).toMatch(/Re-run the deploy to retry/);
    // The schedule spent its three quiet gaps: 10, 20, and 30 seconds.
    expect(time).toBe(60_000);
    // The removal used the same primitive the end phase uses. The calls
    // interleave: upsert, three page checks, then the list and the delete.
    expect(calls.length).toBe(6);
    expect(calls[4]?.init.method).toBe("GET");
    expect(calls[4]?.url).toBe(UPDATE_SECRET_URL);
    expect(calls[5]?.init.method).toBe("DELETE");
    expect(calls[5]?.url).toBe(`${UPDATE_SECRET_URL}/7`);
  });

  test("begin reports a removal failure alongside the run-out", async () => {
    const { fetchText } = stubFetch(
      [
        response(true, 204, ""),
        response(false, 500, '{"Message":"bunny down"}'),
      ],
      [supportedPage],
    );
    const { error, time } = await beginOnClock(fetchText);
    // The run-out still names its deadline, and the removal failure rides
    // in the same error instead of replacing it.
    expect((error as Error).message).toMatch(/within 60 seconds/);
    expect((error as Error).message).toMatch(
      /Removing the flag failed: List edge script secrets failed \(500\)/,
    );
    expect(time).toBe(60_000);
  });

  test("end waits for the new build, then deletes the flag by id", async () => {
    const { calls, fetchText } = stubFetch(
      [
        response(
          true,
          200,
          '{"Secrets":[{"Id":7,"Name":"UPDATE_IN_PROGRESS"}]}',
        ),
      ],
      [activePage],
    );
    const code = await runUpdateMode(
      ["end", "42", "https://site.example", END_BUILD_TAG],
      io(fetchText),
    );
    expect(code).toBe(0);
    const [, listCall, deleteCall] = calls;
    expect(listCall?.init.method).toBe("GET");
    expect(listCall?.init.headers).toEqual({ AccessKey: "key" });
    expect(deleteCall?.url).toBe(`${UPDATE_SECRET_URL}/7`);
    expect(deleteCall?.init.method).toBe("DELETE");
    expect(calls.length).toBe(3);
  });

  test("end removes nothing when the flag is already gone", async () => {
    const { calls, fetchText } = stubFetch(
      [response(true, 200, '{"Secrets":null}')],
      [activePage],
    );
    const code = await runUpdateMode(
      ["end", "42", "https://site.example", END_BUILD_TAG],
      io(fetchText),
    );
    expect(code).toBe(0);
    expect(calls.length).toBe(2);
  });

  test("end surfaces a failed Bunny call", async () => {
    const { fetchText } = stubFetch(
      [response(false, 401, '{"Message":"bad key"}')],
      [activePage],
    );
    await expect(
      runUpdateMode(
        ["end", "42", "https://site.example", END_BUILD_TAG],
        io(fetchText),
      ),
    ).rejects.toThrow(/List edge script secrets failed \(401\)/);
  });

  test("end keeps waiting while the old build answers active", async () => {
    // The post-deploy race: the old build still serves its update page after
    // publish. Only the page naming the published build may pass the wait.
    const { calls, fetchText } = stubFetch(
      [
        response(
          true,
          200,
          '{"Secrets":[{"Id":7,"Name":"UPDATE_IN_PROGRESS"}]}',
        ),
      ],
      [oldBuildActivePage, activePage],
    );
    const code = await runUpdateMode(
      ["end", "42", "https://site.example", END_BUILD_TAG],
      io(fetchText),
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe(READ_ONLY_URL);
    expect(calls[1]?.url).toBe(READ_ONLY_URL);
    expect(calls[2]?.init.method).toBe("GET");
    expect(calls[3]?.url).toBe(`${UPDATE_SECRET_URL}/7`);
    expect(calls.length).toBe(4);
  });

  test("end never clears the flag while only the old build answers", async () => {
    let time = 0;
    const { calls, fetchText } = stubFetch([], [oldBuildActivePage]);
    const error = await runUpdateMode(
      ["end", "42", "https://site.example", END_BUILD_TAG],
      {
        accessKey: "key",
        fetchText,
        log: () => {},
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    ).catch((caught: unknown) => caught);
    // The end wait keeps the short deadline: it verifies the build the
    // deploy just published, which serves promptly after publish.
    expect((error as Error).message).toMatch(
      /a build that reports no build tag, but the deploy expected v2099-01-01-120000/,
    );
    expect(time).toBe(180_000);
    // Only page polls: no secret list, no delete.
    expect(calls.every((call) => call.url === READ_ONLY_URL)).toBe(true);
  });

  test("begin surfaces a failed flag upsert", async () => {
    const { fetchText } = stubFetch(
      [response(false, 401, '{"Message":"bad key"}')],
      [activePage],
    );
    await expect(
      runUpdateMode(["begin", "42", "https://site.example"], io(fetchText)),
    ).rejects.toThrow(/Set UPDATE_IN_PROGRESS failed \(401\)/);
  });

  test("end surfaces a failed secret delete", async () => {
    const { fetchText } = stubFetch(
      [
        response(
          true,
          200,
          '{"Secrets":[{"Id":7,"Name":"UPDATE_IN_PROGRESS"}]}',
        ),
        response(false, 400, '{"Message":"nope"}'),
      ],
      [activePage],
    );
    await expect(
      runUpdateMode(
        ["end", "42", "https://site.example", END_BUILD_TAG],
        io(fetchText),
      ),
    ).rejects.toThrow(/Delete UPDATE_IN_PROGRESS failed \(400\)/);
  });

  test("a failed page check aborts the end wait with the flag still set", async () => {
    const calls: { init: RequestInit; url: string }[] = [];
    const fetchText: FetchText = (url, init) => {
      calls.push({ init, url });
      if (url === READ_ONLY_URL) {
        return Promise.resolve(response(false, 503, "busy"));
      }
      return Promise.resolve(
        response(
          true,
          200,
          '{"Secrets":[{"Id":7,"Name":"UPDATE_IN_PROGRESS"}]}',
        ),
      );
    };
    const error = await runUpdateMode(
      ["end", "42", "https://site.example", END_BUILD_TAG],
      io(fetchText),
    ).catch((caught: unknown) => caught);
    // One page check, then the abort: no secret list, no delete, so the
    // flag stays set for the re-run.
    expect((error as Error).message).toMatch(
      /The last page check failed: The update page check failed \(HTTP 503\)/,
    );
    expect((error as Error).message).toMatch(/UPDATE_IN_PROGRESS is still set/);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(READ_ONLY_URL);
  });

  test("a missing site URL fails before any flag write", async () => {
    // The deploy workflows pass the site URL from a JSON payload; a site
    // whose URL is missing arrives as jq's "null" or an empty argument.
    for (const siteUrl of ["null", ""]) {
      const logged: string[] = [];
      const { calls, fetchText } = stubFetch([], []);
      const code = await runUpdateMode(["begin", "42", siteUrl], {
        accessKey: "key",
        fetchText,
        log: (line) => logged.push(line),
      });
      expect(code).toBe(1);
      assertStringIncludes(
        logged.join("\n"),
        "The deploy passed no site URL for script 42",
      );
      expect(calls).toEqual([]);
    }
  });
});
