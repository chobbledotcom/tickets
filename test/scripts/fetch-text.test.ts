import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fetchText } from "#scripts/fetch-text.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("fetchText", () => {
  test("returns the ok flag, status, and body text of the response", async () => {
    using _fetch = stubFetch(new Response('{"Message":"ok"}', { status: 200 }));

    const result = await fetchText("https://api.bunny.net/code", {
      method: "POST",
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      text: '{"Message":"ok"}',
    });
  });

  test("forwards the url and request init to fetch", async () => {
    using fetchStub = stubFetch(new Response("body", { status: 202 }));

    await fetchText("https://api.bunny.net/code", {
      body: '{"Code":"x"}',
      headers: { AccessKey: "key" },
      method: "POST",
    });

    expect(fetchStub.calls.length).toBe(1);
    expect(fetchStub.calls[0]!.args[0]).toBe("https://api.bunny.net/code");
    expect(fetchStub.calls[0]!.args[1]).toEqual({
      body: '{"Code":"x"}',
      headers: { AccessKey: "key" },
      method: "POST",
    });
  });

  test("surfaces a non-ok response with its status and body", async () => {
    using _fetch = stubFetch(new Response("Unauthorized", { status: 401 }));

    const result = await fetchText("https://api.bunny.net/publish", {
      method: "POST",
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      text: "Unauthorized",
    });
  });

  test("reads a null body as empty text", async () => {
    using _fetch = stubFetch(new Response(null, { status: 204 }));

    const result = await fetchText("https://api.bunny.net/code", {
      method: "POST",
    });

    expect(result).toEqual({ ok: true, status: 204, text: "" });
  });
});
