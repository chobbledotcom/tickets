import { describe, expect, test } from "#test-compat";
import {
  buildCsrfCookie,
  buildSessionCookie,
  clearSessionCookie,
  getCsrfCookieName,
  getSessionCookieName,
  isSecureMode,
} from "#lib/cookies.ts";

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

describe("getCsrfCookieName", () => {
  test("returns __Secure-{name} in secure mode", () => {
    withAllowedDomain("example.com", () => {
      expect(getCsrfCookieName("csrf_token")).toBe("__Secure-csrf_token");
      expect(getCsrfCookieName("admin_login_csrf")).toBe("__Secure-admin_login_csrf");
      expect(getCsrfCookieName("setup_csrf")).toBe("__Secure-setup_csrf");
      expect(getCsrfCookieName("join_csrf")).toBe("__Secure-join_csrf");
    });
  });

  test("returns {name} in dev mode", () => {
    withAllowedDomain("localhost", () => {
      expect(getCsrfCookieName("csrf_token")).toBe("csrf_token");
      expect(getCsrfCookieName("admin_login_csrf")).toBe("admin_login_csrf");
      expect(getCsrfCookieName("setup_csrf")).toBe("setup_csrf");
      expect(getCsrfCookieName("join_csrf")).toBe("join_csrf");
    });
  });
});

describe("buildSessionCookie", () => {
  test("includes __Host-session in secure mode with all required attributes", () => {
    withAllowedDomain("example.com", () => {
      const cookie = buildSessionCookie("test-token");
      expect(cookie).toContain("__Host-session=test-token");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("; Secure;");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=86400");
    });
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    withAllowedDomain("localhost", () => {
      const cookie = buildSessionCookie("test-token");
      expect(cookie).toContain("session=test-token");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).not.toContain("; Secure;");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
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
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("; Secure;");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=0");
    });
  });

  test("includes 'session' in dev mode without Secure flag", () => {
    withAllowedDomain("localhost", () => {
      const cookie = clearSessionCookie();
      expect(cookie).toContain("session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).not.toContain("; Secure;");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=0");
    });
  });
});

describe("buildCsrfCookie", () => {
  test("includes __Secure-{name} in secure mode with all required attributes", () => {
    withAllowedDomain("example.com", () => {
      const cookie = buildCsrfCookie("test_csrf", "token123", { path: "/test" });
      expect(cookie).toContain("__Secure-test_csrf=token123");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("; Secure;");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/test");
      expect(cookie).toContain("Max-Age=3600");
    });
  });

  test("includes 'test_csrf' in dev mode without Secure flag", () => {
    withAllowedDomain("localhost", () => {
      const cookie = buildCsrfCookie("test_csrf", "token123", { path: "/test" });
      expect(cookie).toContain("test_csrf=token123");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).not.toContain("; Secure;");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/test");
      expect(cookie).toContain("Max-Age=3600");
    });
  });

  test("supports inIframe mode with SameSite=None and Partitioned", () => {
    withAllowedDomain("example.com", () => {
      const cookie = buildCsrfCookie("test_csrf", "token123", {
        path: "/test",
        inIframe: true,
      });
      expect(cookie).toContain("__Secure-test_csrf=token123");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("; Secure;");
      expect(cookie).toContain("SameSite=None");
      expect(cookie).toContain("Partitioned");
      expect(cookie).toContain("Path=/test");
      expect(cookie).toContain("Max-Age=3600");
    });
  });

  test("respects custom maxAge", () => {
    withAllowedDomain("example.com", () => {
      const cookie = buildCsrfCookie("test_csrf", "token123", {
        path: "/test",
        maxAge: 7200,
      });
      expect(cookie).toContain("Max-Age=7200");
    });
  });

  test("supports custom path", () => {
    withAllowedDomain("example.com", () => {
      const cookie = buildCsrfCookie("test_csrf", "token123", {
        path: "/custom/path",
      });
      expect(cookie).toContain("Path=/custom/path");
    });
  });
});
