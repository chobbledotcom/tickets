import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { FetchText, FetchTextResult } from "#scripts/fetch-text.ts";
import { runUpdateMode, type UpdateModeIo } from "#scripts/update-mode-lib.ts";
import { updateBuildTagMeta, updatePageMeta } from "#shared/update-guard.ts";
import { says } from "#test-utils/says.ts";

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
    says(logged.join("\n"), "Usage:");
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

  test("begin throws and leaves the flag set when the site never goes read-only", async () => {
    const { fetchText } = stubFetch([response(true, 204, "")], [supportedPage]);
    let time = 0;
    await expect(
      runUpdateMode(["begin", "42", "https://site.example"], {
        accessKey: "key",
        fetchText,
        log: () => {},
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      }),
    ).rejects.toThrow(/UPDATE_IN_PROGRESS is still set/);
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
    await expect(
      runUpdateMode(["end", "42", "https://site.example", END_BUILD_TAG], {
        accessKey: "key",
        fetchText,
        log: () => {},
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      }),
    ).rejects.toThrow(
      /a build that reports no build tag, but the deploy expected v2099-01-01-120000/,
    );
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

  test("a failed page check keeps the wait polling", async () => {
    const calls: { init: RequestInit; url: string }[] = [];
    let pageCalls = 0;
    const fetchText: FetchText = (url, init) => {
      calls.push({ init, url });
      if (url === READ_ONLY_URL) {
        pageCalls += 1;
        return pageCalls === 1
          ? Promise.resolve(response(false, 503, "busy"))
          : Promise.resolve(response(true, 200, activePage));
      }
      return Promise.resolve(
        response(
          true,
          200,
          '{"Secrets":[{"Id":7,"Name":"UPDATE_IN_PROGRESS"}]}',
        ),
      );
    };
    const code = await runUpdateMode(
      ["end", "42", "https://site.example", END_BUILD_TAG],
      io(fetchText),
    );
    expect(code).toBe(0);
    expect(pageCalls).toBe(2);
  });
});
