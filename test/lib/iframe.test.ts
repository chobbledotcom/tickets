import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  appendIframeParam,
  detectIframeMode,
  getIframeMode,
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
      expect(appendIframeParam("/admin/event/1?flash=abc#myform")).toBe(
        "/admin/event/1?flash=abc&iframe=true#myform",
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
  });
});
