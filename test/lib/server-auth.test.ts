import { getSessionCookieName } from "#lib/cookies.ts";
import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { createSession, getSession } from "#lib/db/sessions.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  mockAdminLoginRequest,
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

  describe("GET /admin/login", () => {
    test("shows login page", async () => {
      const response = await handleRequest(mockRequest("/admin/login"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
      expect(response.headers.get("set-cookie")).toContain("__Host-admin_login_csrf=");
    });
  });

  describe("POST /admin/login", () => {
    test("validates required password field", async () => {
      const response = await handleRequest(
        mockAdminLoginRequest({ username: "testadmin", password: "" }),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Password is required");
    });

    test("rejects wrong password", async () => {
      const response = await handleRequest(
        mockAdminLoginRequest({ username: "testadmin", password: "wrong" }),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("Invalid credentials");
    });

    test("accepts correct password and sets cookie", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const response = await handleRequest(
        mockAdminLoginRequest({ username: "testadmin", password }),
      );
      expectAdminRedirect(response);
      expect(response.headers.get("set-cookie")).toContain(`${getSessionCookieName()}=`);
    });


    test("rejects login when CSRF cookie is missing", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/login", {
          username: "testadmin",
          password: TEST_ADMIN_PASSWORD,
          csrf_token: "missing-cookie-token",
        }),
      );

      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid or expired form");
    });

    test("returns 429 when rate limited", async () => {
      // Rate limiting uses direct connection IP (falls back to "direct" in tests)
      const makeRequest = () =>
        mockAdminLoginRequest({ username: "testadmin", password: "wrong" });

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

      const request = mockAdminLoginRequest({ username: "testadmin", password: "wrong" });

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

      const request = mockAdminLoginRequest({ username: "testadmin", password: "wrong" });

      // Make request with server context
      const response = await handleRequest(request, mockServer);
      // Should still work (falls back to "direct")
      expect(response.status).toBe(401);
    });
  });

  describe("POST /admin/logout", () => {
    test("redirects to login when unauthenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/logout", { csrf_token: "invalid" }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest("/admin/logout", { csrf_token: "invalid-csrf" }, cookie),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("succeeds with valid CSRF token", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest("/admin/logout", { csrf_token: csrfToken }, cookie),
      );
      expectAdminRedirect(response);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  describe("GET /admin/logout", () => {
    test("returns 404 not found", async () => {
      const response = await handleRequest(mockRequest("/admin/logout"));
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Not Found");
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
      await createSession("other-session", "other-csrf", Date.now() + 10000, null, 1);

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

    test("displays success message from query param on sessions page", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/sessions?success=Logged+out+of+all+other+sessions",
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Logged out of all other sessions");
      expect(html).toContain('class="success"');
    });

    test("logs out other sessions and shows success message", async () => {
      // Create other sessions before login
      await createSession("other1", "csrf1", Date.now() + 10000, null, 1);
      await createSession("other2", "csrf2", Date.now() + 10000, null, 1);

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(decodeURIComponent(location)).toContain("Logged out of all other sessions");

      // Verify other sessions are deleted
      const other1 = await getSession("other1");
      const other2 = await getSession("other2");
      expect(other1).toBeNull();
      expect(other2).toBeNull();
    });

    test("keeps current session active after logging out others", async () => {
      await createSession("other", "csrf-other", Date.now() + 10000, null, 1);

      const { cookie, csrfToken } = await loginAsAdmin();

      // Extract the session token from cookie
      const sessionMatch = cookie.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
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
      await createSession("expired-token", "csrf-expired", Date.now() - 1000, null, 1);

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
      const { cookie, csrfToken } = await loginAsAdmin();
      const token = cookie.split("=")[1]?.split(";")[0] || "";

      expect(token).not.toBe("");
      const sessionBefore = await getSession(token);
      expect(sessionBefore).not.toBeNull();

      // Now logout
      const logoutResponse = await awaitTestRequest("/admin/logout", {
        cookie,
        data: { csrf_token: csrfToken },
      });
      expect(logoutResponse.status).toBe(302);

      // Verify session was deleted
      const sessionAfter = await getSession(token);
      expect(sessionAfter).toBeNull();
    });
  });

  describe("POST /admin/login (user without wrapped data key)", () => {
    test("returns 403 when user has no wrapped data key (not activated)", async () => {
      // Null out the user's wrapped_data_key to simulate an unactivated user
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "UPDATE users SET wrapped_data_key = NULL WHERE id = 1",
        args: [],
      });

      const response = await handleRequest(
        mockAdminLoginRequest({ username: "testadmin", password: TEST_ADMIN_PASSWORD }),
      );
      // Should return 403 - user exists but is not activated
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("not been activated");
    });
  });

  describe("routes/admin/auth.ts (wrappedDataKey corrupted path)", () => {
    test("login fails when wrapped data key cannot be unwrapped", async () => {
      // Corrupt the user's wrapped_data_key so unwrapKey throws
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "UPDATE users SET wrapped_data_key = 'corrupted_key' WHERE id = 1",
        args: [],
      });

      const response = await handleRequest(
        mockAdminLoginRequest({
          username: "testadmin",
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      // Should fail - KEK can't unwrap corrupted key
      expect(response.status).toBe(401);
    });
  });

  describe("login timing delay", () => {
    test("applies random delay when TEST_SKIP_LOGIN_DELAY is not set", async () => {
      Deno.env.delete("TEST_SKIP_LOGIN_DELAY");
      const start = Date.now();
      const response = await handleRequest(
        mockAdminLoginRequest({ username: "testadmin", password: TEST_ADMIN_PASSWORD }),
      );
      const elapsed = Date.now() - start;
      expectAdminRedirect(response);
      expect(elapsed).toBeGreaterThanOrEqual(100);
      Deno.env.set("TEST_SKIP_LOGIN_DELAY", "1");
    });
  });

  describe("routes/admin/auth.ts (login with null wrappedDataKey)", () => {
    test("login returns 403 when user has null wrappedDataKey", async () => {
      // Null out user's wrapped_data_key
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "UPDATE users SET wrapped_data_key = NULL WHERE id = 1",
        args: [],
      });

      // Login should fail with 403 since user is not activated
      const response = await handleRequest(
        mockAdminLoginRequest({ username: "testadmin", password: TEST_ADMIN_PASSWORD }),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("not been activated");
    });
  });

  describe("session expiration (blank screen test)", () => {
    test("expired session shows login page, not blank screen", async () => {
      // Create an expired session using the real createSession function
      const expiredToken = "expired-blank-screen-test-token";
      await createSession(expiredToken, "csrf-expired", Date.now() - 1000, null, 1);

      // Make request with expired session cookie
      const response = await awaitTestRequest("/admin/", expiredToken);
      expect(response.status).toBe(200);
      const html = await response.text();

      // Verify we get login page, not blank screen or dashboard
      expect(html).toContain("Login");
      expect(html).toContain("<form");
      expect(html.length).toBeGreaterThan(100); // Not blank
      expect(html).not.toContain("Events"); // Should not show dashboard
      expect(html).not.toContain("No events yet"); // Should not show events table

      // Verify session was deleted from database after expiration check
      const deletedSession = await getSession(expiredToken);
      expect(deletedSession).toBeNull();
    });

    test("multiple requests with expired session consistently show login page", async () => {
      // Create an expired session using the real createSession function
      const expiredToken = "expired-multi-request-test-token";
      await createSession(expiredToken, "csrf-expired", Date.now() - 1000, null, 1);

      // Make multiple requests with the same expired session token
      for (let i = 0; i < 3; i++) {
        const response = await awaitTestRequest("/admin/", expiredToken);
        expect(response.status).toBe(200);
        const html = await response.text();

        // Each request should consistently show login page, not blank or dashboard
        expect(html).toContain("Login");
        expect(html.length).toBeGreaterThan(100);
        expect(html).not.toContain("Events");
        expect(html).not.toContain("No events yet");
      }

      // Verify session was deleted after first access
      const deletedSession = await getSession(expiredToken);
      expect(deletedSession).toBeNull();
    });

    test("dashboard always contains expected content structure", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();

      // Verify key content elements that should never be blank
      expect(html).toContain("Events"); // Page title
      expect(html).toContain("<table"); // Table structure
      expect(html).toContain("Event Name"); // Table header
      expect(html.length).toBeGreaterThan(500); // Substantial content
    });

    test("login page always contains expected content structure", async () => {
      const response = await handleRequest(mockRequest("/admin/"));
      expect(response.status).toBe(200);
      const html = await response.text();

      // Verify key content elements of login page
      expect(html).toContain("Login");
      expect(html).toContain("<form");
      expect(html).toContain("username");
      expect(html).toContain("password");
      expect(html.length).toBeGreaterThan(200); // Substantial content
    });
  });

});
