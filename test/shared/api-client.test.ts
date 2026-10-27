/**
 * The shared API client factory: base URL join, auth headers, status check,
 * error parse, and JSON parse + schema validation, in one place.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { defineApiClient } from "#shared/api-client.ts";
import type { FetchResult } from "#shared/fetch.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

const schema = v.object({ name: v.string() });

const client = defineApiClient({
  baseUrl: "https://api.example.test",
  headers: () => ({ Authorization: "Bearer tok" }),
});

test("request sends the auth headers and returns the validated body", async () => {
  const seen: { auth: string | undefined; url: string | undefined } = {
    auth: undefined,
    url: undefined,
  };
  using _fetch = stubFetch((url, init) => {
    seen.auth = (init?.headers as Record<string, string>)?.Authorization;
    seen.url = url;
    return new Response(JSON.stringify({ name: "thing" }));
  });

  const result = await client.request(
    "/things",
    { method: "GET" },
    schema,
    "List things",
  );
  expect(result).toEqual({ ok: true, value: { name: "thing" } });
  expect(seen).toEqual({
    auth: "Bearer tok",
    url: "https://api.example.test/things",
  });
});

test("request lets the caller's own headers win", async () => {
  let seenAuth: string | undefined;
  using _fetch = stubFetch((_url, init) => {
    seenAuth = (init?.headers as Record<string, string>)?.Authorization;
    return new Response(JSON.stringify({ name: "x" }));
  });

  await client.request(
    "/things",
    { headers: { Authorization: "Override" } },
    schema,
    "List things",
  );
  expect(seenAuth).toBe("Override");
});

test("request reports a failed status with the parsed message", async () => {
  using _fetch = stubFetch(
    new Response(JSON.stringify({ error: "refused" }), { status: 422 }),
  );
  const result = await client.request(
    "/things",
    { method: "GET" },
    schema,
    "List things",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("List things failed (422)");
    expect(result.error).toContain("refused");
  }
});

for (const [label, body] of [
  ["a torn body", "not json"],
  ["a body that fails the schema", JSON.stringify({ wrong: true })],
] as const) {
  test(`request reports ${label} as an invalid response`, async () => {
    using _fetch = stubFetch(new Response(body));
    const result = await client.request(
      "/things",
      { method: "GET" },
      schema,
      "List things",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertStringIncludes(
        result.error,
        "List things returned an invalid response",
      );
    }
  });
}

test("send succeeds with no body read", async () => {
  using _fetch = stubFetch(new Response(null, { status: 204 }));
  const result = await client.send(
    "/things/1",
    { method: "DELETE" },
    "Delete thing",
  );
  expect(result).toEqual({ ok: true, value: undefined });
});

test("send reports a failed status", async () => {
  using _fetch = stubFetch(new Response("gone", { status: 404 }));
  const result = await client.send(
    "/things/1",
    { method: "DELETE" },
    "Delete thing",
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    assertStringIncludes(result.error, "Delete thing failed (404)");
  }
});

test("raw returns the untouched response", async () => {
  using _fetch = stubFetch(new Response(JSON.stringify({ name: "raw" })));
  const response = await client.raw("/things", { method: "GET" });
  expect(response.ok).toBe(true);
  expect(JSON.parse(response.text)).toEqual({ name: "raw" });
});

test("a custom error parser supplies the error branch", async () => {
  type RichError = { message: string; code?: string };
  const rich = defineApiClient<RichError>({
    baseUrl: "https://api.example.test",
    headers: () => ({}),
    parseError: (response) => ({
      code: `E${response.status}`,
      message: response.text,
    }),
  });
  using _fetch = stubFetch(new Response("nope", { status: 500 }));
  const result = await rich.send("/things", {}, "List things");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toEqual({ code: "E500", message: "nope" });
  }
});

test("a custom fetch implementation performs the request", async () => {
  const seen: string[] = [];
  const fetchImpl = async (
    url: string,
    init: RequestInit,
  ): Promise<FetchResult> => {
    seen.push(`${init.method} ${url}`);
    return { headers: new Headers(), ok: true, status: 200, text: "{}" };
  };
  const custom = defineApiClient({
    baseUrl: "https://other.test",
    fetchImpl,
    headers: () => ({}),
  });
  const result = await custom.request(
    "/x",
    { method: "PATCH" },
    v.object({}),
    "Noop",
  );
  expect(result).toEqual({ ok: true, value: {} });
  expect(seen).toEqual(["PATCH https://other.test/x"]);
});
