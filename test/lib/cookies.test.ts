import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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

const withAllowedDomain = (domain: string, run: () => void): void => {
  const original = Deno.env.get("ALLOWED_DOMAIN");
  Deno.env.set("ALLOWED_DOMAIN", domain);
  try {
    run();
  } finally {
    if (original === undefined) {
      Deno.env.delete("ALLOWED_DOMAIN");
    } else {
      Deno.env.set("ALLOWED_DOMAIN", original);
    }
  }
};

describe("isSecureMode", () => {
  test("returns true for non-localhost domains", () => {
    withAllowedDomain("example.com", () => {
      expect(isSecureMode()).toBe(true);
    });
  });

  test("returns false for localhost", () => {
    withAllowedDomain("localhost", () => {
      expect(isSecureMode()).toBe(false);
    });
  });
});

describe("getSessionCookieName", () => {
  test("returns __Host-session in secure mode", () => {
    withAllowedDomain("example.com", () => {
      expect(getSessionCookieName()).toBe("__Host-session");
    });
  });

  test("returns 'session' in dev mode", () => {
    withAllowedDomain("localhost", () => {
      expect(getSessionCookieName()).toBe("session");
    });
  });
});

describe("buildSessionCookie", () => {
  test("includes __Host-session in secure mode with all required attributes", () => {
    withAllowedDomain("example.com", () => {
      const cookie = buildSessionCookie("test-token");
      expect(cookie).toContain("__Host-session=test-token");
      expectSecureCookieAttributes(cookie);
      expect(cookie).toContain("Max-Age=86400");
    });
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    withAllowedDomain("localhost", () => {
      const cookie = buildSessionCookie("test-token");
      expect(cookie).toContain("session=test-token");
      expectDevCookieAttributes(cookie);
      expect(cookie).toContain("Max-Age=86400");
    });
  });

  test("respects custom maxAge", () => {
    withAllowedDomain("example.com", () => {
      const cookie = buildSessionCookie("test-token", { maxAge: 3600 });
      expect(cookie).toContain("Max-Age=3600");
    });
  });
});

describe("clearSessionCookie", () => {
  test("includes __Host-session in secure mode with Max-Age=0", () => {
    withAllowedDomain("example.com", () => {
      const cookie = clearSessionCookie();
      expect(cookie).toContain("__Host-session=");
      expectSecureCookieAttributes(cookie);
      expect(cookie).toContain("Max-Age=0");
    });
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    withAllowedDomain("localhost", () => {
      const cookie = clearSessionCookie();
      expect(cookie).toContain("session=");
      expectDevCookieAttributes(cookie);
      expect(cookie).toContain("Max-Age=0");
    });
  });
});
