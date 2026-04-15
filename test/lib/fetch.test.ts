import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { fetchText } from "#lib/fetch.ts";

describe("fetchText", () => {
  let fetchStub: ReturnType<typeof stub<typeof globalThis, "fetch">>;

  afterEach(() => {
    fetchStub?.restore();
  });

  test("returns status, ok, text, and headers from a successful response", async () => {
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response('{"id":1}', {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      ),
    );

    const result = await fetchText("https://example.com/api");

    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('{"id":1}');
    expect(result.headers.get("Content-Type")).toBe("application/json");
  });

  test("returns ok false for error status codes", async () => {
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    );

    const result = await fetchText("https://example.com/missing");

    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
    expect(result.text).toBe("Not Found");
  });

  test("handles empty response body", async () => {
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );

    const result = await fetchText("https://example.com/empty");

    expect(result.status).toBe(204);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("");
  });

  test("forwards request init options", async () => {
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("ok")),
    );

    await fetchText("https://example.com/post", {
      body: "payload",
      headers: { Authorization: "Bearer token" },
      method: "POST",
    });

    expect(fetchStub.calls.length).toBe(1);
    const [url, init] = fetchStub.calls[0]!.args;
    expect(url).toBe("https://example.com/post");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer token",
    );
    expect(init?.body).toBe("payload");
  });

  test("propagates fetch errors", async () => {
    fetchStub = stub(globalThis, "fetch", () =>
      Promise.reject(new TypeError("Network error")),
    );

    await expect(fetchText("https://example.com/fail")).rejects.toThrow(
      "Network error",
    );
  });
});
