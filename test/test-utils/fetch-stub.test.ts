import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";

describe("stubFetch", () => {
  test("returns one response and records the request", async () => {
    using fetchStub = stubFetch(new Response("ready", { status: 201 }));

    const response = await fetch("https://example.com/path", {
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ready");
    expect(fetchStub.calls[0]?.args).toEqual([
      "https://example.com/path",
      { method: "POST" },
    ]);
  });

  test("uses queued responses in order", async () => {
    using _fetch = stubFetch(new Response("first"), new Response("second"));

    expect(await (await fetch("https://example.com/1")).text()).toBe("first");
    expect(await (await fetch("https://example.com/2")).text()).toBe("second");
    await expect(fetch("https://example.com/3")).rejects.toThrow(
      "No fetch reply queued for call 3",
    );
  });

  test("runs a custom responder for every request", async () => {
    using _fetch = stubFetch(
      (input, init) => new Response(`${String(input)}:${init?.method}`),
    );

    expect(
      await (
        await fetch("https://example.com/custom", { method: "PATCH" })
      ).text(),
    ).toBe("https://example.com/custom:PATCH");
  });

  test("gives responders one URL string for URL and Request inputs", async () => {
    using _fetch = stubFetch((url) => new Response(url));

    const urlReply = await fetch(new URL("https://example.com/url"));
    const requestReply = await fetch(
      new Request("https://example.com/request"),
    );

    expect([await urlReply.text(), await requestReply.text()]).toEqual([
      "https://example.com/url",
      "https://example.com/request",
    ]);
  });

  test("rejects with queued errors", async () => {
    using _fetch = stubFetch(new Error("offline"));
    await expect(fetch("https://example.com/error")).rejects.toThrow("offline");
  });

  test("restores fetch after thrown work", () => {
    const original = globalThis.fetch;
    expect(() => {
      using _fetch = stubFetch(new Response());
      throw new Error("stop");
    }).toThrow("stop");
    expect(globalThis.fetch).toBe(original);
  });
});
