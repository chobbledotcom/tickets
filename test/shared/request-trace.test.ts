import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getRequestTrace,
  getTracedRoute,
  getTracedUrl,
  runWithRequestTrace,
} from "#shared/request-trace.ts";

const trace = <T>(url: string, method: string, read: () => T): Promise<T> =>
  runWithRequestTrace(new Request(url, { method }), () =>
    Promise.resolve(read()),
  );

describe("request trace", () => {
  test("records the host the visitor asked for", async () => {
    expect(
      await trace("https://venue.example.com/listings", "GET", getRequestTrace),
    ).toEqual({
      host: "venue.example.com",
      method: "GET",
      route: "/listings",
    });
  });

  test("keeps the port, so two local sites stay apart", async () => {
    const traced = await trace(
      "http://localhost:8081/",
      "GET",
      getRequestTrace,
    );
    expect(traced?.host).toBe("localhost:8081");
  });

  test("names the route the way the request log does", async () => {
    expect(
      await trace(
        "https://venue.example.com/admin/listings/42",
        "POST",
        getTracedRoute,
      ),
    ).toBe("POST /admin/listings/[id]");
  });

  test("builds a public URL with the route's secrets removed", async () => {
    expect(
      await trace(
        "https://venue.example.com/t/9D5F57B232",
        "GET",
        getTracedUrl,
      ),
    ).toBe("https://venue.example.com/t/[redacted]");
  });

  // A query string carries a token on some routes, so it is dropped whole
  // rather than filtered key by key.
  test("drops the query string whole", async () => {
    const url = await trace(
      "https://venue.example.com/checkout?session=cs_live_abc&email=a@b.test",
      "GET",
      getTracedUrl,
    );
    expect(url).toBe("https://venue.example.com/checkout");
  });

  test("reads as no request at all outside a request", () => {
    expect(getRequestTrace()).toBe(null);
    expect(getTracedRoute()).toBe(undefined);
    expect(getTracedUrl()).toBe(undefined);
  });

  test("does not leak one request's trace into the next", async () => {
    await trace("https://a.example.com/one", "GET", getRequestTrace);
    expect(
      await trace("https://b.example.com/two", "GET", getTracedRoute),
    ).toBe("GET /two");
    expect(getRequestTrace()).toBe(null);
  });
});
