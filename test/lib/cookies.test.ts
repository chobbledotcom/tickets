import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { resetAllowedDomain, setAllowedDomainForTest } from "#lib/config.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  getSessionCookieName,
  isSecureMode,
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
  afterEach(() => resetAllowedDomain());

  test("returns true for non-localhost domains", () => {
    setAllowedDomainForTest("example.com");
    expect(isSecureMode()).toBe(true);
  });

  test("returns false for localhost", () => {
    setAllowedDomainForTest("localhost");
    expect(isSecureMode()).toBe(false);
  });
});

describe("getSessionCookieName", () => {
  afterEach(() => resetAllowedDomain());

  test("returns __Host-session in secure mode", () => {
    setAllowedDomainForTest("example.com");
    expect(getSessionCookieName()).toBe("__Host-session");
  });

  test("returns 'session' in dev mode", () => {
    setAllowedDomainForTest("localhost");
    expect(getSessionCookieName()).toBe("session");
  });
});

describe("buildSessionCookie", () => {
  afterEach(() => resetAllowedDomain());

  test("includes __Host-session in secure mode with all required attributes", () => {
    setAllowedDomainForTest("example.com");
    const cookie = buildSessionCookie("test-token");
    expect(cookie).toContain("__Host-session=test-token");
    expectSecureCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=86400");
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    setAllowedDomainForTest("localhost");
    const cookie = buildSessionCookie("test-token");
    expect(cookie).toContain("session=test-token");
    expectDevCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=86400");
  });

  test("respects custom maxAge", () => {
    setAllowedDomainForTest("example.com");
    const cookie = buildSessionCookie("test-token", { maxAge: 3600 });
    expect(cookie).toContain("Max-Age=3600");
  });
});

describe("clearSessionCookie", () => {
  afterEach(() => resetAllowedDomain());

  test("includes __Host-session in secure mode with Max-Age=0", () => {
    setAllowedDomainForTest("example.com");
    const cookie = clearSessionCookie();
    expect(cookie).toContain("__Host-session=");
    expectSecureCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=0");
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    setAllowedDomainForTest("localhost");
    const cookie = clearSessionCookie();
    expect(cookie).toContain("session=");
    expectDevCookieAttributes(cookie);
    expect(cookie).toContain("Max-Age=0");
  });
});
