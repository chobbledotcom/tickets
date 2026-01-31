import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { createSession, getSession } from "#lib/db/sessions.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  loginAsAdmin,
  TEST_ADMIN_PASSWORD,
} from "#test-utils";

describe("server (admin auth)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/", () => {
    test("shows login page when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("shows dashboard when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Events");
    });
  });

  describe("GET /admin (without trailing slash)", () => {
    test("shows login page when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });
  });

  describe("POST /admin/login", () => {
    test("validates required password field", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password: "" }),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Password is required");
    });

    test("rejects wrong password", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password: "wrong" }),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("Invalid credentials");
    });

    test("accepts correct password and sets cookie", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      expectAdminRedirect(response);
      expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    });

    test("returns 429 when rate limited", async () => {
      // Rate limiting uses direct connection IP (falls back to "direct" in tests)
      const makeRequest = () =>
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: "localhost",
          },
          body: new URLSearchParams({ password: "wrong" }).toString(),
        });

      // Make 5 failed attempts to trigger lockout
      for (let i = 0; i < 5; i++) {
        await handleRequest(makeRequest());
      }

      // 6th attempt should be rate limited
      const response = await handleRequest(makeRequest());
      expect(response.status).toBe(429);
      const html = await response.text();
      expect(html).toContain("Too many login attempts");
    });

    test("uses server.requestIP when available", async () => {
      // Mock server object with requestIP function
      const mockServer = {
        requestIP: () => ({ address: "192.168.1.100" }),
      };

      const request = new Request("http://localhost/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost",
        },
        body: new URLSearchParams({ password: "wrong" }).toString(),
      });

      // Make request with server context
      const response = await handleRequest(request, mockServer);
      // Should work (IP is extracted from server.requestIP)
      expect(response.status).toBe(401);
    });

    test("falls back to direct when server.requestIP returns null", async () => {
      // Mock server object where requestIP returns null
      const mockServer = {
        requestIP: () => null,
      };

      const request = new Request("http://localhost/admin/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "localhost",
        },
        body: new URLSearchParams({ password: "wrong" }).toString(),
      });

      // Make request with server context
      const response = await handleRequest(request, mockServer);
      // Should still work (falls back to "direct")
      expect(response.status).toBe(401);
    });
  });

  describe("GET /admin/logout", () => {
    test("clears session and redirects", async () => {
      const response = await handleRequest(mockRequest("/admin/logout"));
      expectAdminRedirect(response);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  describe("GET /admin/sessions", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/sessions"));
      expectAdminRedirect(response);
    });

    test("shows sessions page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sessions");
      expect(html).toContain("Token");
      expect(html).toContain("Expires");
      expect(html).toContain("Current");
    });

    test("highlights current session with mark", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).toContain("<mark>Current</mark>");
    });

    test("shows logout button when other sessions exist", async () => {
      // Create an extra session
      await createSession("other-session", "other-csrf", Date.now() + 10000);

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).toContain("Log out of all other sessions");
    });

    test("does not show logout button when no other sessions", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).not.toContain("Log out of all other sessions");
    });
  });

  describe("POST /admin/sessions", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/sessions", { csrf_token: "test" }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: "invalid-csrf" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("logs out other sessions and shows success message", async () => {
      // Create other sessions before login
      await createSession("other1", "csrf1", Date.now() + 10000);
      await createSession("other2", "csrf2", Date.now() + 10000);

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Logged out of all other sessions");

      // Verify other sessions are deleted
      const other1 = await getSession("other1");
      const other2 = await getSession("other2");
      expect(other1).toBeNull();
      expect(other2).toBeNull();
    });

    test("keeps current session active after logging out others", async () => {
      await createSession("other", "csrf-other", Date.now() + 10000);

      const { cookie, csrfToken } = await loginAsAdmin();

      // Extract the session token from cookie
      const sessionMatch = cookie.match(/__Host-session=([^;]+)/);
      const sessionToken = sessionMatch?.[1];

      await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      // Verify current session still exists
      const currentSession = await getSession(sessionToken || "");
      expect(currentSession).not.toBeNull();
    });
  });

  describe("session expiration", () => {
    test("nonexistent session shows login page", async () => {
      const response = await awaitTestRequest("/admin/", "nonexistent");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("expired session is deleted and shows login page", async () => {
      // Add an expired session directly to the database
      await createSession("expired-token", "csrf-expired", Date.now() - 1000);

      const response = await awaitTestRequest("/admin/", "expired-token");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");

      // Verify the expired session was deleted
      const session = await getSession("expired-token");
      expect(session).toBeNull();
    });
  });

  describe("logout with valid session", () => {
    test("deletes session from database", async () => {
      // Log in first
      const { cookie } = await loginAsAdmin();
      const token = cookie.split("=")[1]?.split(";")[0] || "";

      expect(token).not.toBe("");
      const sessionBefore = await getSession(token);
      expect(sessionBefore).not.toBeNull();

      // Now logout
      const logoutResponse = await awaitTestRequest("/admin/logout", token);
      expect(logoutResponse.status).toBe(302);

      // Verify session was deleted
      const sessionAfter = await getSession(token);
      expect(sessionAfter).toBeNull();
    });
  });

  describe("POST /admin/login (dataKey null path)", () => {
    test("creates session even when dataKey is null", async () => {
      // This test covers the `wrappedDataKey = dataKey ? await wrapKeyWithToken(dataKey, token) : null` path
      // When login succeeds but unwrapDataKey returns null, session still has null wrappedDataKey
      // In normal operation this won't happen since setup creates keys, but we test the code path
      const { spyOn } = await import("#test-compat");
      const { settingsApi } = await import("#lib/db/settings.ts");

      const mockUnwrap = spyOn(settingsApi, "unwrapDataKey");
      mockUnwrap.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
        );
        // Should still redirect (login succeeds)
        expectAdminRedirect(response);
        expect(response.headers.get("set-cookie")).toContain("__Host-session=");
      } finally {
        mockUnwrap.mockRestore();
      }
    });
  });

  describe("routes/admin/auth.ts (wrappedDataKey null path)", () => {
    test("login succeeds even when wrapped data key is missing", async () => {
      // Remove the wrapped_data_key from settings to trigger null path
      const { setSetting } = await import("#lib/db/settings.ts");
      await setSetting("wrapped_data_key", "");

      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      // Login should still succeed - session is created with null wrapped data key
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });
  });

  describe("routes/admin/auth.ts (login with null wrappedDataKey)", () => {
    test("login succeeds but session has null wrappedDataKey when data key is missing", async () => {
      // Delete the wrapped_data_key from settings to make unwrapDataKey return null
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "DELETE FROM settings WHERE key = 'wrapped_data_key'",
        args: [],
      });

      // Login should still succeed (password verification works, data key is just null)
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      // Should redirect to /admin (successful login)
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");

      // Verify session was created with null wrapped_data_key
      const cookie = response.headers.get("set-cookie")!;
      const tokenMatch = cookie.match(/__Host-session=([^;]+)/);
      expect(tokenMatch).not.toBeNull();
      const session = await getSession(tokenMatch![1]!);
      expect(session).not.toBeNull();
      expect(session!.wrapped_data_key).toBeNull();
    });
  });

});
