import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#lib/config.ts";
import {
  buildFlashCookie,
  buildSessionCookie,
  clearFlashCookie,
  clearSessionCookie,
  getSessionCookieName,
  isSecureMode,
  parseFlashValue,
} from "#lib/cookies.ts";

/** Assert common cookie attributes for dev (localhost) mode */
const expectDevCookieAttributes = (cookie: string) => {
  expect(cookie).toContain("HttpOnly");
  expect(cookie).not.toContain("; Secure;");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
};

/** Assert common cookie attributes for secure (non-localhost) mode */
const expectSecureCookieAttributes = (cookie: string) => {
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("; Secure;");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
};

describe("isSecureMode", () => {
  afterEach(() => resetEffectiveDomain());

  test("returns true for non-localhost domains", () => {
    setEffectiveDomainForTest("example.com");
    expect(isSecureMode()).toBe(true);
  });

  test("returns false for localhost", () => {
    setEffectiveDomainForTest("localhost");
    expect(isSecureMode()).toBe(false);
  });
});

describe("getSessionCookieName", () => {
  afterEach(() => resetEffectiveDomain());

  test("returns __Host-session in secure mode", () => {
    setEffectiveDomainForTest("example.com");
    expect(getSessionCookieName()).toBe("__Host-session");
  });

  test("returns 'session' in dev mode", () => {
    setEffectiveDomainForTest("localhost");
    expect(getSessionCookieName()).toBe("session");
  });
});

describe("buildSessionCookie", () => {
  afterEach(() => resetEffectiveDomain());

  test("includes __Host-session in secure mode with all required attributes", () => {
    setEffectiveDomainForTest("example.com");
    const cookie = buildSessionCookie("test-token");
    expect(cookie).toContain("__Host-session=test-token");
    expectSecureCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=86400");
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = buildSessionCookie("test-token");
    expect(cookie).toContain("session=test-token");
    expectDevCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=86400");
  });

  test("respects custom maxAge", () => {
    setEffectiveDomainForTest("example.com");
    const cookie = buildSessionCookie("test-token", { maxAge: 3600 });
    expect(cookie).toContain("Max-Age=3600");
  });
});

describe("clearSessionCookie", () => {
  afterEach(() => resetEffectiveDomain());

  test("includes __Host-session in secure mode with Max-Age=0", () => {
    setEffectiveDomainForTest("example.com");
    const cookie = clearSessionCookie();
    expect(cookie).toContain("__Host-session=");
    expectSecureCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=0");
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = clearSessionCookie();
    expect(cookie).toContain("session=");
    expectDevCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("buildFlashCookie", () => {
  afterEach(() => resetEffectiveDomain());

  test("keys cookie name by flash ID", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = buildFlashCookie("abc123", "Saved", true);
    expect(cookie).toMatch(/^flash_abc123=/);
  });

  test("encodes success message", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = buildFlashCookie("abc123", "Saved", true);
    expect(cookie).toContain(encodeURIComponent("s:Saved"));
  });

  test("encodes error message", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = buildFlashCookie("abc123", "Failed", false);
    expect(cookie).toContain(encodeURIComponent("e:Failed"));
  });

  test("sets short Max-Age", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = buildFlashCookie("abc123", "Saved", true);
    expect(cookie).toContain("Max-Age=10");
  });
});

describe("clearFlashCookie", () => {
  afterEach(() => resetEffectiveDomain());

  test("clears the keyed cookie with Max-Age=0", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = clearFlashCookie("abc123");
    expect(cookie).toMatch(/^flash_abc123=/);
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("parseFlashValue", () => {
  test("parses success flash value", () => {
    expect(parseFlashValue("s:Event created")).toEqual({
      success: "Event created",
    });
  });

  test("parses error flash value", () => {
    expect(parseFlashValue("e:Something went wrong")).toEqual({
      error: "Something went wrong",
    });
  });

  test("decodes URL-encoded values", () => {
    expect(parseFlashValue(encodeURIComponent("s:Hello world"))).toEqual({
      success: "Hello world",
    });
  });

  test("returns null for invalid format", () => {
    expect(parseFlashValue("invalid")).toBeNull();
  });
});
