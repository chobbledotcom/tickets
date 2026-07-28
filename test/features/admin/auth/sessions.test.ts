import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import { createSession, getSession } from "#shared/db/sessions.ts";
import {
  assertAdminHtml,
  expectFlashRedirect,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { loginAsAdmin } from "#test-utils/session.ts";

describeWithEnv("server (admin sessions)", { db: true }, () => {
  describe("GET /admin/sessions", () => {
    testRequiresAuth("/admin/sessions");

    test("shows sessions page when authenticated", async () => {
      await assertAdminHtml(
        "/admin/sessions",
        "Sessions",
        "Token",
        "Expires",
        "Current",
      );
    });

    test("highlights current session with mark", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).toContain("<mark>Current</mark>");
    });

    test("shows logout button when other sessions exist", async () => {
      // Create an extra session
      await createSession(
        "other-session",
        "other-csrf",
        Date.now() + 10000,
        null,
        1,
      );

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
    testRequiresAuth("/admin/sessions", {
      body: { csrf_token: "test" },
      method: "POST",
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

    test("displays success message from flash cookie on sessions page", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/sessions?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader(
            "Logged out of all other sessions",
          )}`,
        },
      );
      await expectHtmlResponse(
        response,
        200,
        "Logged out of all other sessions",
        'class="success"',
      );
    });

    test("logs out other sessions and shows success message", async () => {
      // Create other sessions before login
      await createSession("other1", "csrf1", Date.now() + 10000, null, 1);
      await createSession("other2", "csrf2", Date.now() + 10000, null, 1);

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest("/admin/sessions", { csrf_token: csrfToken }, cookie),
      );
      await expectFlashRedirect(
        "/admin/sessions",
        "Logged out of all other sessions",
      )(response);

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
      const sessionMatch = cookie.match(
        new RegExp(`${getSessionCookieName()}=([^;]+)`),
      );
      const sessionToken = sessionMatch?.[1];

      await handleRequest(
        mockFormRequest("/admin/sessions", { csrf_token: csrfToken }, cookie),
      );

      // Verify current session still exists
      const currentSession = await getSession(sessionToken || "");
      expect(currentSession).not.toBeNull();
    });
  });

  describe("session expiration", () => {
    test("nonexistent session shows login page", async () => {
      const response = await awaitTestRequest("/admin/", "nonexistent");
      await expectHtmlResponse(response, 200, "Login");
    });

    test("expired session is deleted and shows login page", async () => {
      // Add an expired session directly to the database
      await createSession(
        "expired-token",
        "csrf-expired",
        Date.now() - 1000,
        null,
        1,
      );

      const response = await awaitTestRequest("/admin/", "expired-token");
      await expectHtmlResponse(response, 200, "Login");

      // Verify the expired session was deleted
      const session = await getSession("expired-token");
      expect(session).toBeNull();
    });
  });
  describe("session expiration (blank screen test)", () => {
    test("expired session shows login page, not blank screen", async () => {
      // Create an expired session using the real createSession function
      const expiredToken = "expired-blank-screen-test-token";
      await createSession(
        expiredToken,
        "csrf-expired",
        Date.now() - 1000,
        null,
        1,
      );

      // Make request with expired session cookie
      const response = await awaitTestRequest("/admin/", expiredToken);
      expect(response.status).toBe(200);
      const html = await response.text();

      // Verify we get login page, not blank screen or dashboard
      expect(html).toContain("Login");
      expect(html).toContain("<form");
      expect(html.length).toBeGreaterThan(100); // Not blank
      expect(html).not.toContain("Listings"); // Should not show dashboard
      expect(html).not.toContain("No listings yet"); // Should not show listings table

      // Verify session was deleted from database after expiration check
      const deletedSession = await getSession(expiredToken);
      expect(deletedSession).toBeNull();
    });

    test("multiple requests with expired session consistently show login page", async () => {
      // Create an expired session using the real createSession function
      const expiredToken = "expired-multi-request-test-token";
      await createSession(
        expiredToken,
        "csrf-expired",
        Date.now() - 1000,
        null,
        1,
      );

      // Make multiple requests with the same expired session token
      for (let i = 0; i < 3; i++) {
        const response = await awaitTestRequest("/admin/", expiredToken);
        expect(response.status).toBe(200);
        const html = await response.text();

        // Each request should consistently show login page, not blank or dashboard
        expect(html).toContain("Login");
        expect(html.length).toBeGreaterThan(100);
        expect(html).not.toContain("Listings");
        expect(html).not.toContain("No listings yet");
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
      expect(html).toContain("Listings"); // Page title
      expect(html).toContain("<table"); // Table structure
      expect(html).toContain("Listing name"); // Table header
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
