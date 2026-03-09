import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { appendIframeParam, isIframeRequest } from "#lib/iframe.ts";

describe("iframe", () => {
  describe("isIframeRequest", () => {
    test("returns true when iframe=true is present", () => {
      expect(isIframeRequest("https://example.com/ticket/test?iframe=true")).toBe(true);
    });

    test("returns false when iframe param is absent", () => {
      expect(isIframeRequest("https://example.com/ticket/test")).toBe(false);
    });

    test("returns false when iframe param has a different value", () => {
      expect(isIframeRequest("https://example.com/ticket/test?iframe=false")).toBe(false);
    });

    test("returns true with additional query params", () => {
      expect(isIframeRequest("https://example.com/ticket/test?foo=bar&iframe=true")).toBe(true);
    });
  });

  describe("appendIframeParam", () => {
    test("appends ?iframe=true when inIframe is true and no existing query", () => {
      expect(appendIframeParam("/ticket/test", true)).toBe("/ticket/test?iframe=true");
    });

    test("appends &iframe=true when inIframe is true and query exists", () => {
      expect(appendIframeParam("/ticket/reserved?tokens=abc", true)).toBe(
        "/ticket/reserved?tokens=abc&iframe=true",
      );
    });

    test("returns url unchanged when inIframe is false", () => {
      expect(appendIframeParam("/ticket/test", false)).toBe("/ticket/test");
    });

    test("returns url with existing query unchanged when inIframe is false", () => {
      expect(appendIframeParam("/ticket/reserved?tokens=abc", false)).toBe(
        "/ticket/reserved?tokens=abc",
      );
    });
  });
});
