import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encrypt } from "#lib/crypto.ts";
import { createAttendee } from "#lib/db/attendees";
import { createSession, getSession } from "#lib/db/sessions";
import { setSetting } from "#lib/db/settings";
import { resetStripeClient } from "#lib/stripe.ts";
import { handleRequest } from "#src/server.ts";
import {
  awaitTestRequest,
  createEvent,
  createTestDb,
  createTestDbWithSetup,
  getCsrfTokenFromCookie,
  getSetupCsrfToken,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
  mockRequestWithHost,
  mockSetupFormRequest,
  mockTicketFormRequest,
  resetDb,
  TEST_ADMIN_PASSWORD,
} from "#test-utils";

/**
 * Helper to make a ticket form POST request with CSRF token
 * First GETs the page to obtain the CSRF token, then POSTs with it
 */
const submitTicketForm = async (
  eventId: number,
  data: Record<string, string>,
): Promise<Response> => {
  const getResponse = await handleRequest(mockRequest(`/ticket/${eventId}`));
  const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
  if (!csrfToken) throw new Error("Failed to get CSRF token from ticket page");
  return handleRequest(mockTicketFormRequest(eventId, data, csrfToken));
};

describe("server", () => {
  beforeEach(async () => {
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
      expect(html).toContain("Admin Login");
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
      expect(html).toContain("Admin Login");
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
      expect(html).toContain("Admin Settings");
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
      expect(html).toContain("Admin Login"); // Should show login, not dashboard

      // Verify new password works
      const newLoginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: "newpassword123" }),
      );
      expect(newLoginResponse.status).toBe(302);
      expect(newLoginResponse.headers.get("location")).toBe("/admin");
    });
  });

  describe("POST /admin/settings/stripe", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_new123",
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
          "/admin/settings/stripe",
          {
            stripe_secret_key: "sk_test_new123",
            csrf_token: "invalid-csrf-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Invalid CSRF token");
    });

    test("rejects missing stripe key", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("required");
    });

    test("updates stripe key successfully", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            stripe_secret_key: "sk_test_newkey123",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Stripe key updated successfully");
      expect(html).toContain("Admin Settings");
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
  });

  describe("GET /admin/event/:id", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/event/1"));
      expect(response.status).toBe(302);
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

      await createEvent({
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

      await createEvent({
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
      expect(html).toContain("Edit Event");
    });
  });

  describe("GET /admin/event/:id/export", () => {
    test("redirects to login when not authenticated", async () => {
      await createEvent({
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

      await createEvent({
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

      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");
      await createAttendee(1, "Jane Smith", "jane@example.com");

      const response = await awaitTestRequest("/admin/event/1/export", {
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

      await createEvent({
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
      await createEvent({
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

      await createEvent({
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
      expect(html).toContain("Edit Event");
      expect(html).toContain('value="Test Event"');
      expect(html).toContain("Test Description");
      expect(html).toContain('value="100"');
      expect(html).toContain('value="1500"');
      expect(html).toContain('value="https://example.com/thanks"');
    });
  });

  describe("POST /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createEvent({
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

      await createEvent({
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

      await createEvent({
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

    test("updates event when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      await createEvent({
        name: "Original",
        description: "Original Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
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
      const { getEventWithCount } = await import("#lib/db/events");
      const updated = await getEventWithCount(1);
      expect(updated?.name).toBe("Updated Event");
      expect(updated?.description).toBe("Updated Description");
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });
  });

  describe("GET /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      await createEvent({
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

      await createEvent({
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
      await createEvent({
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

      await createEvent({
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

      await createEvent({
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

      await createEvent({
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
      const { getEvent } = await import("#lib/db/events");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });

    test("deletes event with matching name (trimmed)", async () => {
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      await createEvent({
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

      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");
      await createAttendee(1, "Jane Doe", "jane@example.com");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_name: "Test Event",
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify event and attendees were deleted
      const { getEvent } = await import("#lib/db/events");
      const { getAttendees } = await import("#lib/db/attendees");
      const event = await getEvent(1);
      expect(event).toBeNull();

      const attendees = await getAttendees(1);
      expect(attendees).toEqual([]);
    });

    test("skips name verification when verify_name=false (for API users)", async () => {
      await createEvent({
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
      const { getEvent } = await import("#lib/db/events");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });
  });

  describe("DELETE /admin/event/:id/delete", () => {
    test("deletes event using DELETE method", async () => {
      await createEvent({
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
      const { getEvent } = await import("#lib/db/events");
      const event = await getEvent(1);
      expect(event).toBeNull();
    });
  });

  describe("GET /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockRequest("/admin/event/1/attendee/1/delete"),
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

    test("returns 404 for non-existent attendee", async () => {
      await createEvent({
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
      await createEvent({
        name: "Event 1",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createEvent({
        name: "Event 2",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(2, "John Doe", "john@example.com"); // Attendee on event 2

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      // Try to delete attendee from event 2 via event 1 URL
      const response = await awaitTestRequest(
        "/admin/event/1/attendee/1/delete",
        { cookie: cookie || "" },
      );
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/1/delete",
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
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest("/admin/event/1/attendee/1/delete", {
          confirm_name: "John Doe",
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
      await createEvent({
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
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/1/delete",
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
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/1/delete",
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
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/1/delete",
          {
            confirm_name: "john doe", // lowercase
            csrf_token: csrfToken || "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/event/1");

      // Verify attendee was deleted
      const { getAttendee } = await import("#lib/db/attendees");
      const attendee = await getAttendee(1);
      expect(attendee).toBeNull();
    });

    test("deletes attendee with whitespace-trimmed name", async () => {
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const csrfToken = await getCsrfTokenFromCookie(cookie);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/1/delete",
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
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

      // PATCH is not supported by this specific route handler, which returns null.
      // The request then continues through middleware that returns 403.
      const response = await handleRequest(
        new Request("http://localhost/admin/event/1/attendee/1/delete", {
          method: "PATCH",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("DELETE /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("deletes attendee with DELETE method", async () => {
      await createEvent({
        name: "Test Event",
        description: "Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(1, "John Doe", "john@example.com");

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
        new Request("http://localhost/admin/event/1/attendee/1/delete", {
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
      const { getAttendee } = await import("#lib/db/attendees");
      const attendee = await getAttendee(1);
      expect(attendee).toBeNull();
    });
  });

  describe("GET /ticket/:id", () => {
    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(mockRequest("/ticket/999"));
      expect(response.status).toBe(404);
    });

    test("shows ticket page for existing event", async () => {
      await createEvent({
        name: "Test Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest("/ticket/1"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test Event");
      expect(html).toContain("Reserve Ticket");
    });
  });

  describe("POST /ticket/:id", () => {
    test("returns 404 for non-existent event", async () => {
      // Event lookup happens before CSRF validation, so we can test without CSRF
      const response = await handleRequest(
        mockFormRequest("/ticket/999", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request without CSRF token", async () => {
      await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/ticket/1", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid or expired form");
    });

    test("validates required fields", async () => {
      await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(1, { name: "", email: "" });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Your Name is required");
    });

    test("validates name is required", async () => {
      await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(1, {
        name: "   ",
        email: "john@example.com",
      });
      expect(response.status).toBe(400);
    });

    test("validates email is required", async () => {
      await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(1, {
        name: "John",
        email: "   ",
      });
      expect(response.status).toBe(400);
    });

    test("creates attendee and redirects to thank you page", async () => {
      await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(1, {
        name: "John Doe",
        email: "john@example.com",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("rejects when event is full", async () => {
      await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
      });
      await submitTicketForm(1, {
        name: "John",
        email: "john@example.com",
      });

      const response = await submitTicketForm(1, {
        name: "Jane",
        email: "jane@example.com",
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("not enough spots available");
    });

    test("returns 404 for unsupported method on ticket route", async () => {
      await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await awaitTestRequest("/ticket/1", { method: "PUT" });
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
      expect(html).toContain("Admin Login");
    });

    test("expired session is deleted and shows login page", async () => {
      // Add an expired session directly to the database
      await createSession("expired-token", "csrf-expired", Date.now() - 1000);

      const response = await awaitTestRequest("/admin/", "expired-token");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Login");

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
    test("returns error for missing params", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error for missing session_id", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?attendee_id=1"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error for non-existent attendee", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?attendee_id=999&session_id=cs_test"),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Attendee not found");
    });

    test("returns error when attendee exists but payment verification fails", async () => {
      // When there's no Stripe client configured, retrieveCheckoutSession returns null
      const event = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      const response = await handleRequest(
        mockRequest(
          `/payment/success?attendee_id=${attendee.id}&session_id=cs_invalid`,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Payment verification failed");
    });
  });

  describe("GET /payment/cancel", () => {
    test("returns error for missing attendee_id", async () => {
      const response = await handleRequest(mockRequest("/payment/cancel"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error for missing session_id", async () => {
      const event = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      const response = await handleRequest(
        mockRequest(`/payment/cancel?attendee_id=${attendee.id}`),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error for non-existent attendee", async () => {
      const response = await handleRequest(
        mockRequest("/payment/cancel?attendee_id=999&session_id=cs_test"),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Attendee not found");
    });

    test("returns error for invalid session", async () => {
      const { spyOn } = await import("bun:test");
      const stripeModule = await import("#lib/stripe.ts");
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue(null);

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/cancel?attendee_id=${attendee.id}&session_id=invalid`,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Payment session not found");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("returns error for session mismatch", async () => {
      const { spyOn } = await import("bun:test");
      const stripeModule = await import("#lib/stripe.ts");
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_cancel",
        payment_status: "unpaid",
        metadata: {
          attendee_id: "999", // Different from actual attendee
          event_id: String(event.id),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeModule.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/cancel?attendee_id=${attendee.id}&session_id=cs_test_cancel`,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Payment session mismatch");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("returns error when trying to cancel already paid attendee", async () => {
      const { spyOn } = await import("bun:test");
      const stripeModule = await import("#lib/stripe.ts");
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Create an attendee that already has a payment ID
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
        "pi_already_paid",
      );

      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_cancel",
        payment_status: "unpaid",
        metadata: {
          attendee_id: String(attendee.id),
          event_id: String(event.id),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeModule.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/cancel?attendee_id=${attendee.id}&session_id=cs_test_cancel`,
          ),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Cannot cancel a completed payment");
      } finally {
        mockRetrieve.mockRestore();
        resetStripeClient();
      }
    });

    test("deletes unpaid attendee and shows cancel page when session valid", async () => {
      const { spyOn } = await import("bun:test");
      const stripeModule = await import("#lib/stripe.ts");
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_cancel",
        payment_status: "unpaid",
        metadata: {
          attendee_id: String(attendee.id),
          event_id: String(event.id),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeModule.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/cancel?attendee_id=${attendee.id}&session_id=cs_test_cancel`,
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Payment Cancelled");
        expect(html).toContain("/ticket/");

        // Verify attendee was deleted
        const { getAttendee } = await import("#lib/db/attendees");
        const deleted = await getAttendee(attendee.id);
        expect(deleted).toBeNull();
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
    // We use CONFIG_KEYS.STRIPE_SECRET_KEY in database instead of env var

    afterEach(() => {
      resetStripeClient();
    });

    test("handles payment flow error when Stripe fails", async () => {
      // Set a fake Stripe key to enable payments (in database)
      await setSetting("stripe_key", await encrypt("sk_test_fake_key"));

      // Create a paid event
      const event = await createEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      // Try to reserve a ticket - should fail because Stripe key is invalid
      const response = await submitTicketForm(event.id, {
        name: "John Doe",
        email: "john@example.com",
      });

      // Should return error page because Stripe session creation fails
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Failed to create payment session");
    });

    test("free ticket still works when payments enabled", async () => {
      await setSetting("stripe_key", await encrypt("sk_test_fake_key"));

      // Create a free event (no price)
      const event = await createEvent({
        name: "Free Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: null, // free
      });

      const response = await submitTicketForm(event.id, {
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
      await setSetting("stripe_key", await encrypt("sk_test_fake_key"));

      // Create event with 0 price
      const event = await createEvent({
        name: "Zero Price Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0, // zero price
      });

      const response = await submitTicketForm(event.id, {
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
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000, // 10.00 price
      });

      const response = await submitTicketForm(event.id, {
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

    test("returns error when event deleted after attendee created", async () => {
      // This tests the "Event not found" path in loadPaymentCallbackData
      // We need an attendee that references a non-existent event
      const event = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      // Delete the event - need to delete attendee first due to FK constraint
      // then recreate attendee pointing to deleted event
      const { getDb } = await import("#lib/db/client");

      // Disable foreign key checks, delete event, re-enable
      await getDb().execute("PRAGMA foreign_keys = OFF");
      await getDb().execute({
        sql: "DELETE FROM events WHERE id = ?",
        args: [event.id],
      });
      await getDb().execute("PRAGMA foreign_keys = ON");

      // Now try to access payment success - attendee exists but event doesn't
      const response = await handleRequest(
        mockRequest(
          `/payment/success?attendee_id=${attendee.id}&session_id=cs_test`,
        ),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Event not found");
    });

    test("handles successful payment verification with stripe-mock", async () => {
      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      // stripe-mock returns sessions with payment_status=unpaid by default
      // so this will return 400 (verification failed)
      const response = await handleRequest(
        mockRequest(
          `/payment/success?attendee_id=${attendee.id}&session_id=cs_test_mock`,
        ),
      );

      // stripe-mock returns unpaid status, so verification fails
      expect(response.status).toBe(400);
    });

    test("updates attendee and shows success when payment verified", async () => {
      const { spyOn } = await import("bun:test");
      const stripeModule = await import("#lib/stripe.ts");

      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      // Mock retrieveCheckoutSession to return a paid session with correct metadata
      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_paid",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          attendee_id: String(attendee.id),
          event_id: String(event.id),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeModule.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/success?attendee_id=${attendee.id}&session_id=cs_test_paid`,
          ),
        );

        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Payment Successful");
        expect(html).toContain("https://example.com/thanks");

        // Verify attendee was updated with payment ID
        const { getAttendee } = await import("#lib/db/attendees");
        const updatedAttendee = await getAttendee(attendee.id);
        expect(updatedAttendee?.stripe_payment_id).toBe("pi_test_123");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("rejects payment with mismatched attendee_id (IDOR protection)", async () => {
      const { spyOn } = await import("bun:test");
      const stripeModule = await import("#lib/stripe.ts");

      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      // Mock returns a different attendee_id than the one in the URL
      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_paid",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          attendee_id: "999", // Different from actual attendee.id
          event_id: String(event.id),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeModule.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/success?attendee_id=${attendee.id}&session_id=cs_test_paid`,
          ),
        );

        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Payment session mismatch");
      } finally {
        mockRetrieve.mockRestore();
      }
    });

    test("handles already paid attendee (replay protection)", async () => {
      const { spyOn } = await import("bun:test");
      const stripeModule = await import("#lib/stripe.ts");

      await setSetting("stripe_key", await encrypt("sk_test_mock"));

      const event = await createEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });
      // Create attendee that's already paid
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
        "pi_already_paid",
      );

      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_paid",
        payment_status: "paid",
        payment_intent: "pi_test_123",
        metadata: {
          attendee_id: String(attendee.id),
          event_id: String(event.id),
        },
      } as unknown as Awaited<
        ReturnType<typeof stripeModule.retrieveCheckoutSession>
      >);

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/success?attendee_id=${attendee.id}&session_id=cs_test_paid`,
          ),
        );

        // Should show success without updating (idempotent)
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Payment Successful");

        // Verify original payment ID wasn't overwritten
        const { getAttendee } = await import("#lib/db/attendees");
        const checkedAttendee = await getAttendee(attendee.id);
        expect(checkedAttendee?.stripe_payment_id).toBe("pi_already_paid");
      } finally {
        mockRetrieve.mockRestore();
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
        expect(html).toContain("Stripe Secret Key");
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
              stripe_secret_key: "sk_test_123",
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

      test("POST /setup/ without stripe key still works", async () => {
        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        const response = await handleRequest(
          mockSetupFormRequest(
            {
              admin_password: "mypassword123",
              admin_password_confirm: "mypassword123",
              stripe_secret_key: "",
              currency_code: "GBP",
            },
            csrfToken as string,
          ),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
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
        const { spyOn } = await import("bun:test");
        const dbModule = await import("#lib/db/settings");

        const getResponse = await handleRequest(mockRequest("/setup/"));
        const csrfToken = getSetupCsrfToken(
          getResponse.headers.get("set-cookie"),
        );

        // Mock completeSetup to throw an error
        const mockCompleteSetup = spyOn(dbModule, "completeSetup");
        mockCompleteSetup.mockRejectedValue(new Error("Database error"));

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
        await createEvent({
          name: "Event",
          description: "Desc",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(mockRequest("/ticket/1"));
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
        await createEvent({
          name: "Event",
          description: "Desc",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(mockRequest("/ticket/1"));
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

      test("ticket pages also have base security headers", async () => {
        await createEvent({
          name: "Event",
          description: "Desc",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await handleRequest(mockRequest("/ticket/1"));
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
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
    });
  });
});
