/**
 * A typed route handler becomes the promise-returning route a record's page
 * bundle expects.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { asRequestRoute } from "#shared/rest/route-adapters.ts";

describe("the request route adapter", () => {
  test("a synchronous handler answers through a promise with empty params", async () => {
    const seen: [string, unknown][] = [];
    const route = asRequestRoute((request, params) => {
      seen.push([request.url, params]);
      return new Response("sync", { status: 201 });
    });

    const pending = route(new Request("http://localhost/admin/x"));
    expect(pending).toBeInstanceOf(Promise);
    const response = await pending;

    expect([response.status, await response.text()]).toEqual([201, "sync"]);
    expect(seen).toEqual([["http://localhost/admin/x", {}]]);
  });

  test("an async handler answers its own response", async () => {
    const route = asRequestRoute(() => Promise.resolve(new Response("async")));

    expect(await (await route(new Request("http://localhost/"))).text()).toBe(
      "async",
    );
  });
});
