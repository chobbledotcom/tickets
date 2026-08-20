import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createRouter } from "#routes/router.ts";

describe("route matching", () => {
  test("extracts slug and generic parameters", async () => {
    const router = createRouter({
      "GET /file/:name": (_request, params) =>
        new Response(String(params.name)),
      "GET /item/:slug": (_request, params) =>
        new Response(String(params.slug)),
    });
    const request = new Request("http://localhost/");

    const slug = await router(request, "/item/my-listing", "GET");
    const name = await router(request, "/file/report.csv", "GET");
    expect(await slug?.text()).toBe("my-listing");
    expect(await name?.text()).toBe("report.csv");
  });

  test("converts ID parameters to numbers", async () => {
    const router = createRouter({
      "GET /item/:itemId": (_request, params) =>
        new Response(`${typeof params.itemId}:${params.itemId}`),
    });
    const response = await router(
      new Request("http://localhost/item/42"),
      "/item/42",
      "GET",
    );
    expect(await response?.text()).toBe("number:42");
  });

  test("prefers a literal route over a parameter route", async () => {
    const router = createRouter({
      "GET /join/:code": () => new Response("code"),
      "GET /join/complete": () => new Response("complete"),
    });
    const response = await router(
      new Request("http://localhost/join/complete"),
      "/join/complete",
      "GET",
    );
    expect(await response?.text()).toBe("complete");
  });

  test("prefers the route with more literal text, whichever order they are declared in", async () => {
    // Both patterns match "/x/end" and both take one parameter, so the tie is
    // broken by how much of the path is spelled out. Declaration order must
    // not matter — that is the promise that lets tooling sort route files.
    const headEnd: [string, () => Response] = [
      "GET /:head/end",
      () => new Response("head-end"),
    ];
    const xTail: [string, () => Response] = [
      "GET /x/:tail",
      () => new Response("x-tail"),
    ];
    for (const entries of [
      [headEnd, xTail],
      [xTail, headEnd],
    ]) {
      const router = createRouter(Object.fromEntries(entries));
      const response = await router(
        new Request("http://localhost/x/end"),
        "/x/end",
        "GET",
      );
      expect(await response?.text()).toBe("head-end");
    }
  });

  test("returns null when the method or path does not match", async () => {
    const router = createRouter({ "GET /known": () => new Response("ok") });
    const request = new Request("http://localhost/unknown");
    expect(await router(request, "/unknown", "GET")).toBeNull();
    expect(await router(request, "/known", "POST")).toBeNull();
  });
});
