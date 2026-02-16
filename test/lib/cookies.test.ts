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
  });
});
