import { describe, expect, test } from "#test-compat";
import {
  buildClearedSessionCookie,
  buildCsrfCookie,
  buildSessionCookie,
  getCsrfCookieName,
  getSessionCookieName,
  isSecureMode,
} from "#lib/cookies.ts";

describe("cookies policy", () => {
  describe("secure mode", () => {
    test("applies __Host- prefix and Secure attributes", () => {
      Deno.env.set("ALLOWED_DOMAIN", "example.com");

      expect(isSecureMode()).toBe(true);
      expect(getSessionCookieName()).toBe("__Host-session");
      expect(getCsrfCookieName("join_csrf")).toBe("__Host-join_csrf");

      expect(buildSessionCookie("abc")).toContain("__Host-session=abc");
      expect(buildSessionCookie("abc")).toContain("; Secure;");
      expect(buildSessionCookie("abc")).toContain("HttpOnly");
      expect(buildSessionCookie("abc")).toContain("SameSite=Strict");

      expect(buildClearedSessionCookie()).toContain("__Host-session=");
      expect(buildClearedSessionCookie()).toContain("Max-Age=0");
      expect(buildClearedSessionCookie()).toContain("; Secure;");

      expect(buildCsrfCookie("setup_csrf", "tok", { path: "/setup" })).toContain("__Host-setup_csrf=tok");
      expect(buildCsrfCookie("setup_csrf", "tok", { path: "/setup" })).toContain("SameSite=Strict");
      expect(buildCsrfCookie("setup_csrf", "tok", { path: "/setup" })).toContain("; Secure;");

      const iframeCookie = buildCsrfCookie("csrf_token", "tok", { path: "/ticket/x", inIframe: true });
      expect(iframeCookie).toContain("SameSite=None");
      expect(iframeCookie).toContain("Partitioned");
    });
  });

  describe("non-secure localhost mode", () => {
    test("does not apply __Host- prefix or Secure attributes", () => {
      Deno.env.set("ALLOWED_DOMAIN", "localhost");

      expect(isSecureMode()).toBe(false);
      expect(getSessionCookieName()).toBe("session");
      expect(getCsrfCookieName("join_csrf")).toBe("join_csrf");

      const sessionCookie = buildSessionCookie("abc");
      expect(sessionCookie).toContain("session=abc");
      expect(sessionCookie).not.toContain("__Host-");
      expect(sessionCookie).not.toContain("Secure");

      const csrfCookie = buildCsrfCookie("setup_csrf", "tok", { path: "/setup" });
      expect(csrfCookie).toContain("setup_csrf=tok");
      expect(csrfCookie).not.toContain("__Host-");
      expect(csrfCookie).not.toContain("Secure");
    });
  });
});
