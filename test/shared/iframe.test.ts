import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  appendIframeParam,
  detectIframeMode,
  getIframeMode,
  runWithIframeContext,
} from "#shared/iframe.ts";

describe("iframe", () => {
  afterEach(() => {
    detectIframeMode("https://example.com/");
  });

  describe("detectIframeMode", () => {
    test("sets iframe mode to true when iframe=true is present", () => {
      detectIframeMode("https://example.com/ticket/test?iframe=true");
      expect(getIframeMode()).toBe(true);
    });

    test("sets iframe mode to false when iframe param is absent", () => {
      detectIframeMode("https://example.com/ticket/test");
      expect(getIframeMode()).toBe(false);
    });

    test("sets iframe mode to false when iframe param has a different value", () => {
      detectIframeMode("https://example.com/ticket/test?iframe=false");
      expect(getIframeMode()).toBe(false);
    });

    test("sets iframe mode to true with additional query params", () => {
      detectIframeMode("https://example.com/ticket/test?foo=bar&iframe=true");
      expect(getIframeMode()).toBe(true);
    });

    test("rejects invalid request URLs before reading query params", () => {
      expect(() => detectIframeMode("http://[::1")).toThrow(TypeError);
    });
  });

  describe("appendIframeParam", () => {
    test("appends ?iframe=true when in iframe mode and no existing query", () => {
      detectIframeMode("https://example.com/?iframe=true");
      expect(appendIframeParam("/ticket/test")).toBe(
        "/ticket/test?iframe=true",
      );
    });

    test("appends &iframe=true when in iframe mode and query exists", () => {
      detectIframeMode("https://example.com/?iframe=true");
      expect(appendIframeParam("/ticket/reserved?tokens=abc")).toBe(
        "/ticket/reserved?tokens=abc&iframe=true",
      );
    });

    test("returns url unchanged when not in iframe mode", () => {
      detectIframeMode("https://example.com/");
      expect(appendIframeParam("/ticket/test")).toBe("/ticket/test");
    });

    test("returns url with existing query unchanged when not in iframe mode", () => {
      detectIframeMode("https://example.com/");
      expect(appendIframeParam("/ticket/reserved?tokens=abc")).toBe(
        "/ticket/reserved?tokens=abc",
      );
    });

    test("places param before hash fragment", () => {
      detectIframeMode("https://example.com/?iframe=true");
      expect(appendIframeParam("/admin/listing/1?flash=abc#myform")).toBe(
        "/admin/listing/1?flash=abc&iframe=true#myform",
      );
    });

    test("places param before hash fragment when no existing query", () => {
      detectIframeMode("https://example.com/?iframe=true");
      expect(appendIframeParam("/ticket/test#section")).toBe(
        "/ticket/test?iframe=true#section",
      );
    });

    test("does not duplicate iframe param if already present", () => {
      detectIframeMode("https://example.com/?iframe=true");
      expect(appendIframeParam("/ticket/test?iframe=true")).toBe(
        "/ticket/test?iframe=true",
      );
    });

    test("rejects invalid redirect URLs before appending iframe params", () => {
      detectIframeMode("https://example.com/?iframe=true");
      expect(() => appendIframeParam("http://[::1")).toThrow(TypeError);
    });
  });

  describe("request-scoped isolation", () => {
    test("a fresh iframe scope defaults to non-iframe mode", () => {
      // No detectIframeMode call — the scope's initial container must be
      // non-iframe, so an embed flag never leaks in as the default.
      expect(runWithIframeContext(() => getIframeMode())).toBe(false);
    });

    test("iframe mode set inside a scope stays within that scope", () => {
      const inside = runWithIframeContext(() => {
        detectIframeMode("https://example.com/?iframe=true");
        return getIframeMode();
      });
      expect(inside).toBe(true);
      // The per-request container is gone once the scope ends; the ambient
      // fallback (reset by afterEach) is unaffected by the scoped write.
      expect(getIframeMode()).toBe(false);
    });

    test("concurrent request scopes do not leak iframe mode", async () => {
      const embedded = () =>
        runWithIframeContext(async () => {
          detectIframeMode("https://example.com/?iframe=true");
          await new Promise((r) => setTimeout(r, 20));
          return getIframeMode(); // still an iframe request
        });
      const normal = () =>
        runWithIframeContext(async () => {
          await new Promise((r) => setTimeout(r, 5));
          detectIframeMode("https://example.com/"); // would clobber a global
          await new Promise((r) => setTimeout(r, 20));
          return getIframeMode();
        });
      const [a, b] = await Promise.all([embedded(), normal()]);
      expect(a).toBe(true);
      expect(b).toBe(false);
    });
  });
});
