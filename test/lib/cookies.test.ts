<<<<<<< Updated upstream
import { describe, expect, test } from "#test-compat";
import {
  clearSessionCookie,
  buildCsrfCookie,
  buildSessionCookie,
  getCsrfCookieName,
  getSessionCookieName,
  isSecureMode,
} from "#lib/cookies.ts";

describe("cookies policy", () => {
  describe("secure mode", () => {
    test("uses __Host- for session and __Secure- for csrf with Secure attributes", () => {
      Deno.env.set("ALLOWED_DOMAIN", "example.com");

      expect(isSecureMode()).toBe(true);
      expect(getSessionCookieName()).toBe("__Host-session");
      expect(getCsrfCookieName("join_csrf")).toBe("__Secure-join_csrf");

      expect(buildSessionCookie("abc")).toContain("__Host-session=abc");
      expect(buildSessionCookie("abc")).toContain("; Secure;");
      expect(buildSessionCookie("abc")).toContain("HttpOnly");
      expect(buildSessionCookie("abc")).toContain("SameSite=Strict");
      expect(buildSessionCookie("abc")).toContain("Path=/");

      expect(clearSessionCookie()).toContain("__Host-session=");
      expect(clearSessionCookie()).toContain("Max-Age=0");
      expect(clearSessionCookie()).toContain("; Secure;");

      const setupCsrfCookie = buildCsrfCookie("setup_csrf", "tok", {
        path: "/setup",
      });
      expect(setupCsrfCookie).toContain("__Secure-setup_csrf=tok");
      expect(setupCsrfCookie).toContain("SameSite=Strict");
      expect(setupCsrfCookie).toContain("Path=/setup");
      expect(setupCsrfCookie).toContain("; Secure;");

      const iframeCookie = buildCsrfCookie("csrf_token", "tok", {
        path: "/ticket/x",
        inIframe: true,
      });
      expect(iframeCookie).toContain("__Secure-csrf_token=tok");
      expect(iframeCookie).toContain("SameSite=None");
      expect(iframeCookie).toContain("Partitioned");
    });

    test("supports custom max-age values", () => {
      Deno.env.set("ALLOWED_DOMAIN", "example.com");

      const sessionCookie = buildSessionCookie("abc", { maxAge: 120 });
      expect(sessionCookie).toContain("Max-Age=120");

      const csrfCookie = buildCsrfCookie("setup_csrf", "tok", {
        path: "/setup",
        maxAge: 90,
      });
      expect(csrfCookie).toContain("Max-Age=90");
    });
  });

  describe("non-secure localhost mode", () => {
    test("does not apply __Host-/__Secure- prefixes or Secure attributes", () => {
      Deno.env.set("ALLOWED_DOMAIN", "localhost");

      expect(isSecureMode()).toBe(false);
      expect(getSessionCookieName()).toBe("session");
      expect(getCsrfCookieName("join_csrf")).toBe("join_csrf");

      const sessionCookie = buildSessionCookie("abc");
      expect(sessionCookie).toContain("session=abc");
      expect(sessionCookie).not.toContain("__Host-");
      expect(sessionCookie).not.toContain("__Secure-");
      expect(sessionCookie).not.toContain("Secure");

      const csrfCookie = buildCsrfCookie("setup_csrf", "tok", { path: "/setup" });
      expect(csrfCookie).toContain("setup_csrf=tok");
      expect(csrfCookie).not.toContain("__Host-");
      expect(csrfCookie).not.toContain("__Secure-");
      expect(csrfCookie).not.toContain("Secure");
    });
=======
/**
 * Unit tests for the cookie policy module
 */

import { describe, expect, test } from "#test-compat";
import {
  buildCsrfCookie,
  buildClearedSessionCookie,
  buildSessionCookie,
  getSessionCookieName,
  getCsrfCookieName,
  isSecureMode,
} from "#lib/cookies.ts";

describe("isSecureMode", () => {
  test("returns true for non-localhost domains", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    expect(isSecureMode()).toBe(true);
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("returns false for localhost", () => {
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
    expect(isSecureMode()).toBe(false);
    Deno.env.delete("ALLOWED_DOMAIN");
  });
});

describe("getSessionCookieName", () => {
  test("returns __Host-session in secure mode", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    expect(getSessionCookieName()).toBe("__Host-session");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("returns 'session' in dev mode", () => {
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
    expect(getSessionCookieName()).toBe("session");
    Deno.env.delete("ALLOWED_DOMAIN");
  });
});

describe("getCsrfCookieName", () => {
  test("returns __Host-{name} in secure mode", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    expect(getCsrfCookieName("csrf_token")).toBe("__Host-csrf_token");
    expect(getCsrfCookieName("admin_login_csrf")).toBe("__Host-admin_login_csrf");
    expect(getCsrfCookieName("setup_csrf")).toBe("__Host-setup_csrf");
    expect(getCsrfCookieName("join_csrf")).toBe("__Host-join_csrf");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("returns {name} in dev mode", () => {
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
    expect(getCsrfCookieName("csrf_token")).toBe("csrf_token");
    expect(getCsrfCookieName("admin_login_csrf")).toBe("admin_login_csrf");
    expect(getCsrfCookieName("setup_csrf")).toBe("setup_csrf");
    expect(getCsrfCookieName("join_csrf")).toBe("join_csrf");
    Deno.env.delete("ALLOWED_DOMAIN");
  });
});

describe("buildSessionCookie", () => {
  test("includes __Host-session in secure mode with all required attributes", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const cookie = buildSessionCookie("test-token");
    expect(cookie).toContain("__Host-session=test-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=86400");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
    const cookie = buildSessionCookie("test-token");
    expect(cookie).toContain("session=test-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=86400");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("respects custom maxAge", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const cookie = buildSessionCookie("test-token", { maxAge: 3600 });
    expect(cookie).toContain("Max-Age=3600");
    Deno.env.delete("ALLOWED_DOMAIN");
  });
});

describe("buildClearedSessionCookie", () => {
  test("includes __Host-session in secure mode with Max-Age=0", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const cookie = buildClearedSessionCookie();
    expect(cookie).toContain("__Host-session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=0");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
    const cookie = buildClearedSessionCookie();
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=0");
    Deno.env.delete("ALLOWED_DOMAIN");
  });
});

describe("buildCsrfCookie", () => {
  test("includes __Host-{name} in secure mode with all required attributes", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const cookie = buildCsrfCookie("test_csrf", "token123", { path: "/test" });
    expect(cookie).toContain("__Host-test_csrf=token123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/test");
    expect(cookie).toContain("Max-Age=3600");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("includes 'test_csrf' in dev mode without Secure flag", () => {
    Deno.env.set("ALLOWED_DOMAIN", "localhost");
    const cookie = buildCsrfCookie("test_csrf", "token123", { path: "/test" });
    expect(cookie).toContain("test_csrf=token123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/test");
    expect(cookie).toContain("Max-Age=3600");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("supports inIframe mode with SameSite=None and Partitioned", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const cookie = buildCsrfCookie("test_csrf", "token123", { path: "/test", inIframe: true });
    expect(cookie).toContain("__Host-test_csrf=token123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
    expect(cookie).toContain("Path=/test");
    expect(cookie).toContain("Max-Age=3600");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("respects custom maxAge", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const cookie = buildCsrfCookie("test_csrf", "token123", { path: "/test", maxAge: 7200 });
    expect(cookie).toContain("Max-Age=7200");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("supports custom path", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const cookie = buildCsrfCookie("test_csrf", "token123", { path: "/custom/path" });
    expect(cookie).toContain("Path=/custom/path");
    Deno.env.delete("ALLOWED_DOMAIN");
  });
});

describe("cookie policy security attributes", () => {
  test("all cookies consistently apply HttpOnly in both modes", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const secure = [
      buildSessionCookie("token1"),
      buildClearedSessionCookie(),
      buildCsrfCookie("test", "token2", { path: "/test" }),
    ];
    secure.forEach(cookie => {
      expect(cookie).toContain("HttpOnly");
    });
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("session cookies consistently apply SameSite=Strict in both modes", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const secure = [
      buildSessionCookie("token1"),
      buildClearedSessionCookie(),
    ];
    secure.forEach(cookie => {
      expect(cookie).toContain("SameSite=Strict");
    });
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("CSRF cookies consistently apply SameSite=Strict unless inIframe=true", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const normal = buildCsrfCookie("test", "token", { path: "/test" });
    expect(normal).toContain("SameSite=Strict");

    const iframe = buildCsrfCookie("test", "token", { path: "/test", inIframe: true });
    expect(iframe).toContain("SameSite=None");
    expect(iframe).toContain("Partitioned");
    Deno.env.delete("ALLOWED_DOMAIN");
  });

  test("Secure flag only applied in secure mode", () => {
    Deno.env.set("ALLOWED_DOMAIN", "example.com");
    const secure = [
      buildSessionCookie("token1"),
      buildClearedSessionCookie(),
      buildCsrfCookie("test", "token2", { path: "/test" }),
    ];
    secure.forEach(cookie => {
      expect(cookie).toContain("Secure");
    });
    Deno.env.delete("ALLOWED_DOMAIN");
>>>>>>> Stashed changes
  });
});
