import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { FetchText, FetchTextResult } from "#scripts/fetch-text.ts";
import { runUpdateMode, type UpdateModeIo } from "#scripts/update-mode-lib.ts";
import { updatePageMeta } from "#shared/update-guard.ts";

const UPDATE_SECRET_URL = "https://api.bunny.net/compute/script/42/secrets";
const READ_ONLY_URL = "https://site.example/read-only";

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

const activePage = `<html><head>${updatePageMeta("active")}</head></html>`;
const supportedPage = `<html><head>${updatePageMeta("supported")}</head></html>`;
const plainPage = "<html><head></head></html>";

describe("runUpdateMode", () => {
  test("rejects an unknown command with the usage line", async () => {
    const logged: string[] = [];
    const { fetchText } = stubFetch([], []);
    const code = await runUpdateMode(["lift", "42", "https://site.example"], {
      accessKey: "key",
      fetchText,
      log: (line) => logged.push(line),
    });
    expect(code).toBe(1);
    expect(logged.join("\n")).toContain("Usage:");
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
      ["end", "42", "https://site.example"],
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
      ["end", "42", "https://site.example"],
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
      runUpdateMode(["end", "42", "https://site.example"], io(fetchText)),
    ).rejects.toThrow(/List edge script secrets failed \(401\)/);
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
      runUpdateMode(["end", "42", "https://site.example"], io(fetchText)),
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
      ["end", "42", "https://site.example"],
      io(fetchText),
    );
    expect(code).toBe(0);
    expect(pageCalls).toBe(2);
  });
});
