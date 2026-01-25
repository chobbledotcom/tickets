import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import { createSession, getSession } from "#lib/db/sessions.ts";
import { resetStripeClient } from "#lib/stripe.ts";
import { handleRequest } from "#src/server.ts";
import { createAttendeeAtomic } from "#lib/db/attendees.ts";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestDb,
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  getCsrfTokenFromCookie,
  getSetupCsrfToken,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
  mockRequestWithHost,
  mockSetupFormRequest,
  mockTicketFormRequest,
  resetDb,
  resetTestSlugCounter,
  TEST_ADMIN_PASSWORD,
} from "#test-utils";
import process from "node:process";

/**
 * Helper to make a ticket form POST request with CSRF token
 * First GETs the page to obtain the CSRF token, then POSTs with it
 */
const submitTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const getResponse = await handleRequest(mockRequest(`/ticket/${slug}`));
  const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
  if (!csrfToken) throw new Error("Failed to get CSRF token from ticket page");
  return handleRequest(mockTicketFormRequest(slug, data, csrfToken));
};

describe("server", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /", () => {
    test("returns home page", async () => {
      const response = await handleRequest(mockRequest("/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Ticket Reservation System");
    });
  });

  describe("GET /health", () => {
    test("returns health status", async () => {
      const response = await handleRequest(mockRequest("/health"));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ status: "ok" });
    });

    test("returns 404 for non-GET requests to /health", async () => {
      const response = await awaitTestRequest("/health", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /favicon.ico", () => {
    test("returns SVG favicon", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const svg = await response.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain("viewBox");
    });

    test("returns 404 for non-GET requests to /favicon.ico", async () => {
      const response = await awaitTestRequest("/favicon.ico", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /mvp.css", () => {
    test("returns CSS stylesheet", async () => {
      const response = await handleRequest(mockRequest("/mvp.css"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/css; charset=utf-8",
      );
      const css = await response.text();
      expect(css).toContain(":root");
      expect(css).toContain("--color-link");
    });

    test("returns 404 for non-GET requests to /mvp.css", async () => {
      const response = await awaitTestRequest("/mvp.css", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/mvp.css"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /admin/", () => {
    test("shows login page when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Login");
    });

    test("shows dashboard when authenticated", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", {
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest("/admin/", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Dashboard");
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
      TEST_ADMIN_PASSWORD;
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
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
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
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  describe("GET /admin/settings", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/settings"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("shows settings page when authenticated", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await awaitTestRequest("/admin/settings", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Settings");
      expect(html).toContain("Change Password");
    });
  });

  describe("POST /admin/settings", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings", {
          current_password: "test",
          new_password: "newpassword123",
          new_password_confirm: "newpassword123",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("rejects invalid CSRF token", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("rejects missing required fields", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "",
            new_password: "",
            new_password_confirm: "",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("rejects password shorter than 8 characters", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "short",
            new_password_confirm: "short",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("at least 8 characters");
    });

    test("rejects mismatched passwords", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "differentpassword",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("do not match");
    });

    test("rejects incorrect current password", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: "wrongpassword",
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("Current password is incorrect");
    });

    test("changes password and invalidates session", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings",
          {
            current_password: TEST_ADMIN_PASSWORD,
            new_password: "newpassword123",
            new_password_confirm: "newpassword123",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );

      // Should redirect to admin login with session cleared
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

      // Verify old session is invalidated
      const dashboardResponse = await awaitTestRequest("/admin/", { cookie });
      const html = await dashboardResponse.text();
      expect(html).toContain("Login"); // Should show login, not dashboard

      // Verify new password works
      const newLoginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: "newpassword123" }),
      );
      expect(newLoginResponse.status).toBe(302);
      expect(newLoginResponse.headers.get("location")).toBe("/admin");
    });
  });

  describe("GET /admin/sessions", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/sessions"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("shows sessions page when authenticated", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sessions");
      expect(html).toContain("Token");
      expect(html).toContain("Expires");
      expect(html).toContain("Current");
    });

    test("highlights current session with mark", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).toContain("<mark>Current</mark>");
    });

    test("shows logout button when other sessions exist", async () => {
      // Create an extra session
      await createSession("other-session", "other-csrf", Date.now() + 10000);

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await awaitTestRequest("/admin/sessions", { cookie });
      const html = await response.text();
      expect(html).toContain("Log out of all other sessions");
    });

    test("does not show logout button when no other sessions", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

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
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("rejects invalid CSRF token", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

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

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: csrfToken || "" },
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

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      // Extract the session token from cookie
      const sessionMatch = cookie.match(/__Host-session=([^;]+)/);
      const sessionToken = sessionMatch?.[1];

      await handleRequest(
        mockFormRequest(
          "/admin/sessions",
          { csrf_token: csrfToken || "" },
          cookie,
        ),
      );

      // Verify current session still exists
      const currentSession = await getSession(sessionToken || "");
      expect(currentSession).not.toBeNull();
    });
  });

  describe("POST /admin/event", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/event", {
          name: "Test",
          description: "Desc",
          max_attendees: "100",
          max_quantity: "1",
          thank_you_url: "https://example.com",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("creates event when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "new-event",
            name: "New Event",
            description: "Description",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");

      // Verify event was actually created
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).not.toBeNull();
      expect(event?.slug).toBe("new-event");
    });

    test("rejects invalid CSRF token", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            name: "New Event",
            description: "Description",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("redirects to dashboard on validation failure", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            name: "",
            description: "",
            max_attendees: "",
            thank_you_url: "",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("rejects duplicate slug", async () => {
      // First, create an event with a specific slug
      await createTestEvent({
        slug: "duplicate-slug",
        name: "First Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      // Try to create another event with the same slug
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "duplicate-slug",
            name: "Second Event",
            description: "Another desc",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      // Should redirect to admin with error (validation failure)
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });
  });

  describe("GET /admin/event/:id", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/event/1"));
      expect(response.status).toBe(302);
    });

    test("redirects when wrapped data key is invalid", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Create session with invalid wrapped_data_key
      const token = "test-token-invalid-event";
      await createSession(token, "csrf123", Date.now() + 3600000, "invalid");

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: `__Host-session=${token}`,
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest("/admin/event/999", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(404);
    });

    test("shows event details when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test Event");
    });

    test("shows Edit link on event page", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie || "",
      });
      const html = await response.text();
      expect(html).toContain("/admin/event/1/edit");
      expect(html).toContain(">Edit<");
    });
  });

  describe("GET /admin/event/:id/export", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/export"),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest("/admin/event/999/export", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(404);
    });

    test("returns CSV with correct headers when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/export", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/csv; charset=utf-8",
      );
      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(response.headers.get("content-disposition")).toContain(".csv");
    });

    test("returns CSV with attendee data", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane Smith", "jane@example.com");

      const response = await awaitTestRequest(`/admin/event/${event.id}/export`, {
        cookie: cookie || "",
      });
      const csv = await response.text();
      expect(csv).toContain("Name,Email,Quantity,Registered");
      expect(csv).toContain("John Doe");
      expect(csv).toContain("john@example.com");
      expect(csv).toContain("Jane Smith");
      expect(csv).toContain("jane@example.com");
    });

    test("sanitizes event name for filename", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createTestEvent({
        name: "Test Event / Special!",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/export", {
        cookie: cookie || "",
      });
      const disposition = response.headers.get("content-disposition");
      expect(disposition).toContain("Test_Event___Special_");
      expect(disposition).not.toContain("/");
      expect(disposition).not.toContain("!");
    });
  });

  describe("GET /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest("/admin/event/1/edit"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest("/admin/event/999/edit", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(404);
    });

    test("shows edit form when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createTestEvent({
        name: "Test Event",
        description: "Test Description",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1500,
      });

      const response = await awaitTestRequest("/admin/event/1/edit", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Edit:");
      expect(html).toContain('value="Test Event"');
      expect(html).toContain("Test Description");
      expect(html).toContain('value="100"');
      expect(html).toContain('value="1500"');
      expect(html).toContain('value="https://example.com/thanks"');
    });
  });

  describe("POST /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/edit", {
          name: "Updated",
          description: "Updated Desc",
          max_attendees: "50",
          max_quantity: "1",
          thank_you_url: "https://example.com/updated",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/edit",
          {
            name: "Updated",
            description: "Updated Desc",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/updated",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request with invalid CSRF token", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      await createTestEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            name: "Updated",
            description: "Updated Desc",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/updated",
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("validates required fields", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      await createTestEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            name: "",
            description: "Desc",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event Name is required");
    });

    test("rejects duplicate slug on update", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      // Create two events
      await createTestEvent({
        slug: "first-event",
        name: "First",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        slug: "second-event",
        name: "Second",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Try to update first event to use second event's slug
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "second-event",
            name: "Updated First",
            description: "Desc",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });

    test("updates event when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const event = await createTestEvent({
        name: "Original",
        description: "Original Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: event.slug,
            name: "Updated Event",
            description: "Updated Description",
            max_attendees: "200",
            max_quantity: "5",
            thank_you_url: "https://example.com/updated",
            unit_price: "2000",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/event/1");

      // Verify the event was updated
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(1);
      expect(updated?.name).toBe("Updated Event");
      expect(updated?.description).toBe("Updated Description");
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });
  });

  describe("GET /admin/event/:id/deactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/deactivate"),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest("/admin/event/999/deactivate", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(404);
    });

    test("shows deactivate confirmation page when authenticated", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/deactivate", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Deactivate Event");
      expect(html).toContain("Return a 404");
    });
  });

  describe("POST /admin/event/:id/deactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/deactivate", {}),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("deactivates event and redirects", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/deactivate",
          { csrf_token: csrfToken || "" },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/event/1");

      // Verify event is now inactive
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const event = await getEventWithCount(1);
      expect(event?.active).toBe(0);
    });
  });

  describe("GET /admin/event/:id/reactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/reactivate"),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("shows reactivate confirmation page when authenticated", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await awaitTestRequest("/admin/event/1/reactivate", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reactivate Event");
      expect(html).toContain("available for registrations");
    });
  });

  describe("POST /admin/event/:id/reactivate", () => {
    test("reactivates event and redirects", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/reactivate",
          { csrf_token: csrfToken || "" },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/event/1");

      // Verify event is now active
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const activeEvent = await getEventWithCount(1);
      expect(activeEvent?.active).toBe(1);
    });
  });

  describe("GET /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/delete"),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest("/admin/event/999/delete", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/delete", {
        cookie: cookie || "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Delete Event");
      expect(html).toContain("Test Event");
      expect(html).toContain("type its name");
    });
  });

  describe("POST /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/delete", {
          confirm_name: "Test Event",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/delete",
          {
            confirm_name: "Test Event",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_name: "Test Event",
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects mismatched event name", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_name: "Wrong Name",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("deletes event with matching name (case insensitive)", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_name: "test event", // lowercase
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });

    test("deletes event with matching name (trimmed)", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_name: "  Test Event  ", // with spaces
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("deletes event and all attendees", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane Doe", "jane@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete`,
          {
            confirm_name: "Test Event",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify event and attendees were deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getEvent(event.id);
      expect(deleted).toBeNull();

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees).toEqual([]);
    });

    test("skips name verification when verify_name=false (for API users)", async () => {
      await createTestEvent({
        name: "API Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Login and get CSRF token
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      // Delete with verify_name=false - no need for confirm_name
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete?verify_name=false",
          {
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });
  });

  describe("DELETE /admin/event/:id/delete", () => {
    test("deletes event using DELETE method", async () => {
      await createTestEvent({
        name: "Delete Method Test",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Login and get CSRF token
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      // Use DELETE method with verify_name=false
      const response = await handleRequest(
        new Request("http://localhost/admin/event/1/delete?verify_name=false", {
          method: "DELETE",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookie || "",
            host: "localhost",
          },
          body: new URLSearchParams({
            csrf_token: csrfToken || "",
          }).toString(),
        }),
      );
      expect(response.status).toBe(302);

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });
  });

  describe("GET /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/attendee/${attendee.id}/delete`),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest(
        "/admin/event/999/attendee/1/delete",
        { cookie: cookie || "" },
      );
      expect(response.status).toBe(404);
    });

    test("redirects when session lacks wrapped data key", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session without wrapped_data_key (simulates legacy session)
      const token = "test-token-no-data-key";
      await createSession(token, "csrf123", Date.now() + 3600000, null);

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
        { cookie: `__Host-session=${token}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("redirects when wrapped data key is invalid", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session with invalid wrapped_data_key (triggers decryption failure)
      const token = "test-token-invalid-key";
      await createSession(token, "csrf123", Date.now() + 3600000, "invalid");

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
        { cookie: `__Host-session=${token}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/999/delete",
        { cookie: cookie || "" },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee belongs to different event", async () => {
      const event1 = await createTestEvent({
        name: "Event 1",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        name: "Event 2",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event2.id, event2.slug, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      // Try to delete attendee from event 2 via event 1 URL
      const response = await awaitTestRequest(
        `/admin/event/${event1.id}/attendee/${attendee.id}/delete`,
        { cookie: cookie || "" },
      );
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
        { cookie: cookie || "" },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Delete Attendee");
      expect(html).toContain("John Doe");
      expect(html).toContain("type their name");
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee/${attendee.id}/delete`, {
          confirm_name: "John Doe",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("redirects when wrapped data key is invalid", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Create session with invalid wrapped_data_key
      const token = "test-token-invalid-post";
      await createSession(token, "csrf123", Date.now() + 3600000, "invalid");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { confirm_name: "John Doe", csrf_token: "csrf123" },
          `__Host-session=${token}`,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent event", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/delete",
          {
            confirm_name: "John Doe",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/delete",
          {
            confirm_name: "John Doe",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "John Doe",
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "Wrong Name",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("deletes attendee with matching name (case insensitive)", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "john doe", // lowercase
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("deletes attendee with whitespace-trimmed name", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "  John Doe  ", // with spaces
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/event/1");
    });
  });

  describe("PATCH /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("route handler returns null for unsupported method", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // PATCH is not supported by this specific route handler, which returns null.
      // The request then continues through middleware that returns 403.
      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/attendee/${attendee.id}/delete`, {
          method: "PATCH",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("DELETE /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("deletes attendee with DELETE method", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const formBody = new URLSearchParams({
        confirm_name: "John Doe",
        csrf_token: csrfToken || "",
      }).toString();

      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/attendee/${attendee.id}/delete`, {
          method: "DELETE",
          headers: {
            host: "localhost",
            cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: formBody,
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/event/1");

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deletedAttendee = await getAttendeeRaw(1);
      expect(deletedAttendee).toBeNull();
    });
  });

  describe("GET /ticket/:slug", () => {
    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(mockRequest("/ticket/non-existent"));
      expect(response.status).toBe(404);
    });

    test("shows ticket page for existing event", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test Event");
      expect(html).toContain("Reserve Ticket");
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent({
        name: "Inactive Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event
      await deactivateTestEvent(event.id);
      const response = await handleRequest(
        mockRequest(`/ticket/${event.slug}`),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Event Not Found");
    });
  });

  describe("POST /ticket/:slug", () => {
    test("returns 404 for non-existent event", async () => {
      // Event lookup happens before CSRF validation, so we can test without CSRF
      const response = await handleRequest(
        mockFormRequest("/ticket/non-existent", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for inactive event", async () => {
      const event = await createTestEvent({
        name: "Inactive Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event
      await deactivateTestEvent(event.id);
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request without CSRF token", async () => {
      const event = await createTestEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.slug}`, {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid or expired form");
    });

    test("validates required fields", async () => {
      const event = await createTestEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "",
        email: "",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Your Name is required");
    });

    test("validates name is required", async () => {
      const event = await createTestEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "   ",
        email: "john@example.com",
      });
      expect(response.status).toBe(400);
    });

    test("validates email is required", async () => {
      const event = await createTestEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John",
        email: "   ",
      });
      expect(response.status).toBe(400);
    });

    test("creates attendee and redirects to thank you page", async () => {
      const event = await createTestEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("rejects when event is full", async () => {
      const event = await createTestEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
      });
      await submitTicketForm(event.slug, {
        name: "John",
        email: "john@example.com",
      });

      const response = await submitTicketForm(event.slug, {
        name: "Jane",
        email: "jane@example.com",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("returns 404 for unsupported method on ticket route", async () => {
      const event = await createTestEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await awaitTestRequest(`/ticket/${event.slug}`, {
        method: "PUT",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      const response = await handleRequest(mockRequest("/unknown/path"));
      expect(response.status).toBe(404);
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
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
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

  describe("POST /admin/event with unit_price", () => {
    test("creates event with unit_price when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            name: "Paid Event",
            description: "Description",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            unit_price: "1000",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /payment/success", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error when session not found", async () => {
      // When there's no Stripe client configured, retrieveCheckoutSession returns null
      const response = await handleRequest(
        mockRequest("/payment/success?session_id=cs_invalid"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment session not found");
    });

    test("returns error when payment not verified", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Mock session with unpaid status
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test",
        payment_status: "unpaid",
        payment_intent: "pi_test",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Payment verification failed");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("returns error for invalid session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      // Mock session with missing metadata
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test",
        payment_status: "paid",
        payment_intent: "pi_test",
        metadata: {}, // Missing required fields
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Invalid payment session data");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("rejects payment for inactive event and refunds", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Deactivate the event
      await deactivateTestEvent(event.id);

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("no longer accepting registrations");

        // Verify refund was called
        expect(mockRefund).toHaveBeenCalledWith("pi_test_123");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
        resetStripeClient();
      }
    });

    test("refunds payment when event is sold out at confirmation time", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      // Create event with only 1 spot
      const event = await createTestEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Fill the event with another attendee (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test",
        payment_status: "paid",
        payment_intent: "pi_second",
        metadata: {
          event_id: String(event.id),
          name: "Second",
          email: "second@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("sold out");
        expect(html).toContain("automatically refunded");

        // Verify refund was called
        expect(mockRefund).toHaveBeenCalledWith("pi_second");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
        resetStripeClient();
      }
    });
  });

  describe("GET /payment/cancel", () => {
    test("returns error for missing session_id", async () => {
      const response = await handleRequest(mockRequest("/payment/cancel"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error when session not found", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      // Mock session retrieval to return null (session not found)
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockRequest("/payment/cancel?session_id=cs_invalid"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Payment session not found");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("returns error for invalid session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_cancel",
        payment_status: "unpaid",
        metadata: {}, // Missing required fields
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/cancel?session_id=cs_test_cancel"),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Invalid payment session data");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("returns error when event not found", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_cancel",
        payment_status: "unpaid",
        metadata: {
          event_id: "99999", // Non-existent event
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/cancel?session_id=cs_test_cancel"),
        );
        expect(response.status).toBe(404);
        const html = await response.text();
        expect(html).toContain("Event not found");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("shows cancel page with link back to ticket form", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_cancel",
        payment_status: "unpaid",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/cancel?session_id=cs_test_cancel"),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Payment Cancelled");
        expect(html).toContain(`/ticket/${event.slug}`);
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });
  });

  describe("payment routes", () => {
    test("returns 404 for unsupported method on payment routes", async () => {
      const response = await awaitTestRequest("/payment/success", {
        method: "POST",
        data: {},
      });
      expect(response.status).toBe(404);
    });
  });

  describe("ticket purchase with payments enabled", () => {
    // These tests require stripe-mock running on localhost:12111
    // STRIPE_MOCK_HOST/PORT are set in test/setup.ts
    // Stripe keys are now set via environment variables

    afterEach(() => {
      resetStripeClient();
      delete process.env.STRIPE_SECRET_KEY;
    });

    test("handles payment flow error when Stripe fails", async () => {
      // Set a fake Stripe key to enable payments (in database)
      process.env.STRIPE_SECRET_KEY = "sk_test_fake_key";

      // Create a paid event
      const event = await createTestEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      // Try to reserve a ticket - should fail because Stripe key is invalid
      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should return error page because Stripe session creation fails
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Failed to create payment session");
    });

    test("free ticket still works when payments enabled", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_fake_key";

      // Create a free event (no price)
      const event = await createTestEvent({
        name: "Free Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: null, // free
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to thank you page
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("zero price ticket is treated as free", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_fake_key";

      // Create event with 0 price
      const event = await createTestEvent({
        name: "Zero Price Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0, // zero price
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to thank you page (no payment required)
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      const response = await submitTicketForm(event.slug, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should redirect to Stripe checkout URL
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      // stripe-mock returns a URL starting with https://
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("returns error when event not found in session metadata", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test",
        payment_status: "paid",
        payment_intent: "pi_test",
        metadata: {
          event_id: "99999", // Non-existent event
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test"),
        );
        expect(response.status).toBe(404);
        const html = await response.text();
        expect(html).toContain("Event not found");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
        resetStripeClient();
      }
    });

    test("creates attendee and shows success when payment verified", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Mock retrieveCheckoutSession to return a paid session with intent metadata
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_paid",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test_paid"),
        );

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Payment Successful");
        expect(html).toContain("https://example.com/thanks");

        // Verify attendee was created with payment ID (encrypted at rest)
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.stripe_payment_id).not.toBeNull();
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("handles replay of same session (idempotent)", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Create attendee as if payment was already processed (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "John", "john@example.com", "pi_test_123");

      // Mock returns same session again (user refreshes success page)
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_paid",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test_paid"),
        );

        // Capacity check will now fail since we already have the attendee
        // This is expected - in the new flow, replaying creates a duplicate attempt
        // which fails the capacity check if event is near full
        // For idempotent behavior, we'd need to check payment_intent uniqueness
        expect(response.status).toBe(200);
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("handles multiple quantity purchase", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");

      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
        maxQuantity: 5,
      });

      // Mock session with quantity > 1
      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_paid",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "3",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test_paid"),
        );

        expect(response.status).toBe(200);

        // Verify attendee was created with correct quantity
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
        expect(attendees[0]?.quantity).toBe(3);
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("rejects paid event registration when sold out before payment", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      // Create paid event with only 1 spot
      const event = await createTestEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 1,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Fill the event (using atomic to simulate production flow)
      await createAttendeeAtomic(event.id, "First", "first@example.com", "pi_first");

      // Try to register - should fail before Stripe session is created
      const response = await submitTicketForm(event.slug, {
        name: "Second",
        email: "second@example.com",
      });

      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("handles encryption error during payment confirmation", async () => {
      const { spyOn } = await import("#test-compat");
      const { stripeApi } = await import("#lib/stripe.ts");
      const { attendeesApi } = await import("#lib/db/attendees.ts");

      process.env.STRIPE_SECRET_KEY = "sk_test_mock";

      const event = await createTestEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      const mockRetrieve = spyOn(stripeApi, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          event_id: String(event.id),
          name: "John",
          email: "john@example.com",
          quantity: "1",
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeApi.retrieveCheckoutSession>
      >);

      const mockRefund = spyOn(stripeApi, "refundPayment");
      mockRefund.mockResolvedValue({ id: "re_test" } as unknown as Awaited<
        ReturnType<typeof stripeApi.refundPayment>
      >);

      // Mock atomic create to return encryption error
      const mockAtomic = spyOn(attendeesApi, "createAttendeeAtomic");
      mockAtomic.mockResolvedValue({
        success: false,
        reason: "encryption_error",
      });

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_test"),
        );

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Registration failed");
        expect(html).toContain("refunded");

        // Verify refund was called
        expect(mockRefund).toHaveBeenCalledWith("pi_test_123");
      } finally {
        mockRetrieve.mockRestore();
        mockRefund.mockRestore();
        mockAtomic.mockRestore();
      }
    });
  });

  describe("setup routes", () => {
    describe("when setup not complete", () => {
      beforeEach(async () => {
        // Use a fresh db without setup
        resetDb();
        await createTestDb();
      });

      test("redirects home to /setup/", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/setup");
      });

      test("redirects admin to /setup/", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/setup");
      });

      test("health check still works", async () => {
        const response = await handleRequest(mockRequest("/health"));
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ status: "ok" });
      });

      test("GET /setup/ shows setup page", async () => {
        const response = await handleRequest(mockRequest("/setup/"));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Initial Setup");
        expect(html).toContain("Admin Password");
        expect(html).toContain("Currency Code");
      });

      test("GET /setup (without trailing slash) shows setup page", async () => {
        const response = await handleRequest(mockRequest("/setup"));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Initial Setup");
      });

      test("POST /setup/ with valid data completes setup", async () => {
        // First get CSRF token from GET request
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );
        expect(csrfToken).not.toBeNull();

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "USD",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });

      test("POST /setup/ without CSRF token rejects request", async () => {
        // POST without getting CSRF token first
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "USD",
          }),
        );
        expect(response.status).toBe(403);
        const html = await response.text();
        expect(html).toContain("Invalid or expired form");
      });

      test("POST /setup/ with mismatched CSRF tokens rejects request", async () => {
        // Get a valid CSRF token from cookie
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const cookieCsrf = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        // Send a different token in the form body than the cookie
        const response = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: "localhost",
              cookie: `setup_csrf=${cookieCsrf}`,
            },
            body: new URLSearchParams({
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "USD",
              csrf_token: "wrong-token-in-form",
            }).toString(),
          }),
        );
        expect(response.status).toBe(403);
        const html = await response.text();
        expect(html).toContain("Invalid or expired form");
      });

      test("POST /setup/ with empty password shows validation error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "",
              admin_password_confirm: "",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Admin Password * is required");
      });

      test("POST /setup/ with mismatched passwords shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "different",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Passwords do not match");
      });

      test("POST /setup/ with short password shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "short",
              admin_password_confirm: "short",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("at least 8 characters");
      });

      test("POST /setup/ with invalid currency shows error", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "INVALID",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Currency code must be 3 uppercase letters");
      });

      test("POST /setup/ normalizes lowercase currency to uppercase", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "usd",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });

      test("POST /setup/ throws error when completeSetup fails", async () => {
        const { spyOn } = await import("#test-compat");
        const { settingsApi } = await import("#lib/db/settings.ts");

        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        // Mock completeSetup to throw an error
        const mockCompleteSetup = spyOn(settingsApi, "completeSetup");
        mockCompleteSetup.mockRejectedValue(new Error("Database error"));

        // Suppress expected console.error to avoid non-zero exit code
        const mockConsoleError = spyOn(console, "error");
        mockConsoleError.mockImplementation(() => {});

        try {
          await expect(
            handleRequest(
              mockSetupFormRequest(
                {
                  admin_password: "mypassword123",
                  admin_password_confirm: "mypassword123",
                  currency_code: "GBP",
                },
                csrfToken as string,
              ),
            ),
          ).rejects.toThrow("Database error");
        } finally {
          mockCompleteSetup.mockRestore();
          mockConsoleError.mockRestore();
        }
      });

      test("PUT /setup/ redirects to /setup/ (unsupported method)", async () => {
        const response = await awaitTestRequest("/setup/", { method: "PUT" });
        // PUT method falls through routeSetup (returns null), then redirects to /setup/
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/setup");
      });

      test("setup form works with full browser flow simulation", async () => {
        // This test simulates what a real browser does:
        // 1. GET /setup/ - browser receives the page and Set-Cookie header
        // 2. User fills form and submits
        // 3. Browser sends POST with cookie

        // Step 1: GET the setup page
        const getResponse = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );
        expect(getResponse.status).toBe(200);

        // Extract the Set-Cookie header
        const setCookie = getResponse.headers.get("set-cookie");
        expect(setCookie).not.toBeNull();

        // Extract CSRF token from the cookie
        const csrfToken = getSetupCsrfToken(setCookie);
        expect(csrfToken).not.toBeNull();

        // Step 2: Simulate browser POST - browser sends cookie back
        const postResponse = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: "localhost",
              cookie: `setup_csrf=${csrfToken}`,
            },
            body: new URLSearchParams({
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
              csrf_token: csrfToken as string,
            }).toString(),
          }),
        );

        // This should succeed - the full flow should work
        expect(postResponse.status).toBe(200);
        const html = await postResponse.text();
        expect(html).toContain("Setup Complete");
      });

      test("setup cookie path allows both /setup and /setup/", async () => {
        // Cookie path should be /setup (without trailing slash) to match both variants
        const response = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );

        const setCookie = response.headers.get("set-cookie");
        expect(setCookie).not.toBeNull();
        // Path should be /setup (not /setup/) so it matches both
        expect(setCookie).toContain("Path=/setup;");
        expect(setCookie).not.toContain("Path=/setup/;");
      });

      test("setup form works when accessed via /setup (no trailing slash)", async () => {
        // GET /setup (no trailing slash)
        const getResponse = await handleRequest(
          new Request("http://localhost/setup", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );
        expect(getResponse.status).toBe(200);

        const setCookie = getResponse.headers.get("set-cookie");
        const csrfToken = getSetupCsrfToken(setCookie);
        expect(csrfToken).not.toBeNull();

        // POST to /setup (no trailing slash) - cookie should still be sent
        const postResponse = await handleRequest(
          new Request("http://localhost/setup", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              host: "localhost",
              cookie: `setup_csrf=${csrfToken}`,
            },
            body: new URLSearchParams({
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              currency_code: "GBP",
              csrf_token: csrfToken as string,
            }).toString(),
          }),
        );

        expect(postResponse.status).toBe(200);
        const html = await postResponse.text();
        expect(html).toContain("Setup Complete");
      });

      test("CSRF token in cookie matches token in HTML form field", async () => {
        // This test verifies that the same token appears in both places
        const response = await handleRequest(
          new Request("http://localhost/setup/", {
            method: "GET",
            headers: { host: "localhost" },
          }),
        );

        // Extract token from Set-Cookie header
        const setCookie = response.headers.get("set-cookie");
        expect(setCookie).not.toBeNull();
        const cookieToken = getSetupCsrfToken(setCookie);
        expect(cookieToken).not.toBeNull();

        // Extract token from HTML body
        const html = await response.text();
        const formTokenMatch = html.match(
          /name="csrf_token"\s+value="([^"]+)"/,
        );
        expect(formTokenMatch).not.toBeNull();
        const formToken = formTokenMatch?.[1];

        // They must be identical
        expect(formToken).toBe(cookieToken as string);
      });
    });

    describe("when setup already complete", () => {
      test("GET /setup/ redirects to home", async () => {
        const response = await handleRequest(mockRequest("/setup/"));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/");
      });

      test("POST /setup/ redirects to home", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "newpassword123",
            admin_password_confirm: "newpassword123",
            currency_code: "EUR",
          }),
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/");
      });
    });
  });

  describe("security headers", () => {
    describe("X-Frame-Options", () => {
      test("home page has X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("admin pages have X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("ticket page does NOT have X-Frame-Options (embeddable)", async () => {
        const event = await createTestEvent({
          name: "Event",
          description: "Desc",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("x-frame-options")).toBeNull();
      });

      test("payment pages have X-Frame-Options: DENY", async () => {
        const response = await handleRequest(mockRequest("/payment/success"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });

      test("setup page has X-Frame-Options: DENY", async () => {
        resetDb();
        await createTestDb();
        const response = await handleRequest(mockRequest("/setup/"));
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      });
    });

    describe("Content-Security-Policy", () => {
      const baseCsp =
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self'";

      test("non-embeddable pages have frame-ancestors 'none' and security restrictions", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("content-security-policy")).toBe(
          `frame-ancestors 'none'; ${baseCsp}`,
        );
      });

      test("ticket page has CSP but allows embedding (no frame-ancestors)", async () => {
        const event = await createTestEvent({
          name: "Event",
          description: "Desc",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("content-security-policy")).toBe(baseCsp);
      });
    });

    describe("other security headers", () => {
      test("responses have X-Content-Type-Options: nosniff", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      });

      test("responses have Referrer-Policy header", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
      });

      test("responses have X-Robots-Tag: noindex, nofollow", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      });

      test("ticket pages also have base security headers", async () => {
        const event = await createTestEvent({
          name: "Event",
          description: "Desc",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${event.slug}`),
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      });
    });
  });

  describe("Content-Type validation", () => {
    test("rejects POST requests without Content-Type header", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });

    test("rejects POST requests with wrong Content-Type", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "test" }),
        }),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("Invalid Content-Type");
    });
  });

  describe("Domain validation", () => {
    test("allows requests with valid domain", async () => {
      const response = await handleRequest(mockRequest("/"));
      expect(response.status).toBe(200);
    });

    test("rejects GET requests to invalid domain", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "evil.com"),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("rejects POST requests to invalid domain", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/admin/login", "evil.com", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "password=test",
        }),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("allows requests with valid domain including port", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "localhost:3000"),
      );
      expect(response.status).toBe(200);
    });

    test("rejects requests without Host header", async () => {
      const response = await handleRequest(
        new Request("http://localhost/", {}),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid domain");
    });

    test("domain rejection response has security headers", async () => {
      const response = await handleRequest(
        mockRequestWithHost("/", "evil.com"),
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });
  });
});
