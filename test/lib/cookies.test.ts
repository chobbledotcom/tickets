import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { parseCookies } from "#routes/url.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import {
  buildFlashCookie,
  buildSessionCookie,
  clearFlashCookie,
  clearSessionCookie,
  getSessionCookieName,
  isSecureMode,
  parseFlashValue,
} from "#shared/cookies.ts";

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

  test("encodes success message as JSON", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = buildFlashCookie("abc123", "Saved", true);
    expect(cookie).toContain(
      encodeURIComponent(JSON.stringify({ m: "Saved", t: "s" })),
    );
  });

  test("encodes error message as JSON", () => {
    setEffectiveDomainForTest("localhost");
    const cookie = buildFlashCookie("abc123", "Failed", false);
    expect(cookie).toContain(
      encodeURIComponent(JSON.stringify({ m: "Failed", t: "e" })),
    );
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
    const encoded = JSON.stringify({ m: "Listing created", t: "s" });
    expect(parseFlashValue(encoded)).toEqual({
      error: undefined,
      info: undefined,
      result: undefined,
      success: "Listing created",
    });
  });

  test("parses error flash value", () => {
    const encoded = JSON.stringify({ m: "Something went wrong", t: "e" });
    expect(parseFlashValue(encoded)).toEqual({
      error: "Something went wrong",
      info: undefined,
      result: undefined,
      success: undefined,
    });
  });

  test("parses info flash value", () => {
    const encoded = JSON.stringify({ m: "You've unsubscribed", t: "i" });
    expect(parseFlashValue(encoded)).toEqual({
      error: undefined,
      info: "You've unsubscribed",
      result: undefined,
      success: undefined,
    });
  });

  test("decodes URL-encoded values", () => {
    const encoded = encodeURIComponent(
      JSON.stringify({ m: "Hello world", t: "s" }),
    );
    expect(parseFlashValue(encoded)).toEqual({
      error: undefined,
      info: undefined,
      result: undefined,
      success: "Hello world",
    });
  });

  test("parses flash with result", () => {
    const encoded = JSON.stringify({ m: "Created", r: "abc123", t: "s" });
    expect(parseFlashValue(encoded)).toEqual({
      error: undefined,
      info: undefined,
      result: "abc123",
      success: "Created",
    });
  });

  test("throws for invalid format", () => {
    expect(() => parseFlashValue("invalid")).toThrow();
  });
});

describe("parseCookies", () => {
  const reqWithCookies = (cookie: string) =>
    new Request("http://localhost/", { headers: { cookie } });

  test("parses simple key=value pairs", () => {
    const cookies = parseCookies(reqWithCookies("session=abc; lang=en"));
    expect(cookies.get("session")).toBe("abc");
    expect(cookies.get("lang")).toBe("en");
  });

  test("returns empty map for no cookie header", () => {
    const cookies = parseCookies(new Request("http://localhost/"));
    expect(cookies.size).toBe(0);
  });

  test("preserves equals signs in cookie values", () => {
    const cookies = parseCookies(
      reqWithCookies("token=eyJhbGci.payload.sig=="),
    );
    expect(cookies.get("token")).toBe("eyJhbGci.payload.sig==");
  });

  test("handles URI-encoded flash cookie values", () => {
    const payload = encodeURIComponent(JSON.stringify({ m: "Saved", t: "s" }));
    const cookies = parseCookies(reqWithCookies(`flash_abc=${payload}`));
    expect(cookies.get("flash_abc")).toBe(payload);
  });
});
