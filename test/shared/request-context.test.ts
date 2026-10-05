import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  appendIframeParam,
  detectIframeMode,
  getIframeMode,
  getLocale,
  getRequestClientIp,
  getRequestId,
  getRequestTrace,
} from "#shared/request-context.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("request-context", () => {
  test("carries the locale the pipeline parsed", async () => {
    expect(await withRequestContext(() => getLocale(), { locale: "de" })).toBe(
      "de",
    );
  });

  test("defaults the locale to en outside a request", () => {
    expect(getLocale()).toBe("en");
  });

  test("carries the client IP the boundary resolved", async () => {
    expect(
      await withRequestContext(() => getRequestClientIp(), {
        clientIp: "198.51.100.9",
      }),
    ).toBe("198.51.100.9");
  });

  test("falls back to direct outside any request scope", () => {
    expect(getRequestClientIp()).toBe("direct");
  });

  test("mints a 4-character hex request id inside the context", async () => {
    expect(await withRequestContext(() => getRequestId())).toMatch(
      /^[0-9a-f]{4}$/,
    );
  });

  test("mints different ids for concurrent requests", async () => {
    const [a, b] = await Promise.all([
      withRequestContext(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getRequestId();
      }),
      withRequestContext(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getRequestId();
      }),
    ]);
    expect(a).not.toBe(b);
  });

  test("reads an empty id outside a request", () => {
    expect(getRequestId()).toBe("");
  });

  test("carries the redacted trace of the request", async () => {
    const trace = await withRequestContext(() => getRequestTrace());
    expect(trace).toEqual({
      host: "example.com",
      method: "GET",
      route: "/test",
    });
  });

  test("reads no trace outside a request", () => {
    expect(getRequestTrace()).toBe(null);
  });

  describe("iframe mode", () => {
    test("detects iframe=true", async () => {
      expect(
        await withRequestContext(() => {
          detectIframeMode(new URL("https://example.com/t?iframe=true"));
          return getIframeMode();
        }),
      ).toBe(true);
    });

    test("detects an absent or non-true param as non-iframe", async () => {
      expect(
        await withRequestContext(() => {
          detectIframeMode(new URL("https://example.com/t?iframe=false"));
          return getIframeMode();
        }),
      ).toBe(false);
    });

    test("presets iframe mode from the request url", async () => {
      expect(
        await withRequestContext(() => getIframeMode(), { iframe: true }),
      ).toBe(true);
    });

    test("reads non-iframe mode outside a request", () => {
      expect(getIframeMode()).toBe(false);
    });

    test("a detect call outside a request cannot set the ambient mode", () => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      expect(getIframeMode()).toBe(false);
    });

    test("appends the param when in iframe mode", async () => {
      expect(
        await withRequestContext(
          () => appendIframeParam("/ticket/test?tokens=abc#form"),
          { iframe: true },
        ),
      ).toBe("/ticket/test?tokens=abc&iframe=true#form");
    });

    test("leaves the url unchanged when not in iframe mode", () => {
      expect(appendIframeParam("/ticket/test?tokens=abc")).toBe(
        "/ticket/test?tokens=abc",
      );
    });

    test("rejects an invalid redirect url before appending", async () => {
      await expect(
        withRequestContext(() => appendIframeParam("http://[::1"), {
          iframe: true,
        }),
      ).rejects.toThrow(TypeError);
    });

    test("concurrent requests do not leak iframe mode", async () => {
      const [embedded, normal] = await Promise.all([
        withRequestContext(
          async () => {
            detectIframeMode(new URL("https://example.com/?iframe=true"));
            await new Promise((r) => setTimeout(r, 20));
            return getIframeMode();
          },
          { iframe: true },
        ),
        withRequestContext(async () => {
          detectIframeMode(new URL("https://example.com/"));
          await new Promise((r) => setTimeout(r, 20));
          return getIframeMode();
        }),
      ]);
      expect(embedded).toBe(true);
      expect(normal).toBe(false);
    });
  });
});
