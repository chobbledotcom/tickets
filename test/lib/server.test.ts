import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  createEvent,
  createSession,
  getOrCreateAdminPassword,
  getSession,
  initDb,
  setDb,
} from "#lib/db.ts";
import { handleRequest } from "#src/server.ts";

const makeRequest = (path: string, options: RequestInit = {}): Request => {
  return new Request(`http://localhost${path}`, options);
};

const makeFormRequest = (
  path: string,
  data: Record<string, string>,
  cookie?: string,
): Request => {
  const body = new URLSearchParams(data).toString();
  const headers: HeadersInit = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body,
  });
};

describe("server", () => {
  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    setDb(client);
    await initDb();
  });

  afterEach(() => {
    setDb(null);
  });

  describe("GET /", () => {
    test("returns home page", async () => {
      const response = await handleRequest(makeRequest("/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Ticket Reservation System");
    });
  });

  describe("GET /health", () => {
    test("returns health status", async () => {
      const response = await handleRequest(makeRequest("/health"));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ status: "ok" });
    });
  });

  describe("GET /admin/", () => {
    test("shows login page when not authenticated", async () => {
      const response = await handleRequest(makeRequest("/admin/"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Login");
    });

    test("shows dashboard when authenticated", async () => {
      await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", {
          password: await getOrCreateAdminPassword(),
        }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        new Request("http://localhost/admin/", {
          headers: { cookie: cookie || "" },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Dashboard");
    });
  });

  describe("GET /admin (without trailing slash)", () => {
    test("shows login page when not authenticated", async () => {
      const response = await handleRequest(makeRequest("/admin"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Login");
    });
  });

  describe("POST /admin/login", () => {
    test("rejects wrong password", async () => {
      await getOrCreateAdminPassword();
      const response = await handleRequest(
        makeFormRequest("/admin/login", { password: "wrong" }),
      );
      expect(response.status).toBe(401);
      const html = await response.text();
      expect(html).toContain("Invalid password");
    });

    test("accepts correct password and sets cookie", async () => {
      const password = await getOrCreateAdminPassword();
      const response = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
      expect(response.headers.get("set-cookie")).toContain("session=");
    });

    test("accepts ADMIN_PASSWORD env var", async () => {
      const original = process.env.ADMIN_PASSWORD;
      process.env.ADMIN_PASSWORD = "env-test-password";

      const response = await handleRequest(
        makeFormRequest("/admin/login", { password: "env-test-password" }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
      expect(response.headers.get("set-cookie")).toContain("session=");

      process.env.ADMIN_PASSWORD = original;
    });
  });

  describe("GET /admin/logout", () => {
    test("clears session and redirects", async () => {
      const response = await handleRequest(makeRequest("/admin/logout"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  describe("POST /admin/event", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        makeFormRequest("/admin/event", {
          name: "Test",
          description: "Desc",
          max_attendees: "100",
          thank_you_url: "https://example.com",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });

    test("creates event when authenticated", async () => {
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        makeFormRequest(
          "/admin/event",
          {
            name: "New Event",
            description: "Description",
            max_attendees: "50",
            thank_you_url: "https://example.com/thanks",
          },
          cookie || "",
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });
  });

  describe("GET /admin/event/:id", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(makeRequest("/admin/event/1"));
      expect(response.status).toBe(302);
    });

    test("returns 404 for non-existent event", async () => {
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        new Request("http://localhost/admin/event/999", {
          headers: { cookie: cookie || "" },
        }),
      );
      expect(response.status).toBe(404);
    });

    test("shows event details when authenticated", async () => {
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createEvent("Test Event", "Desc", 100, "https://example.com");

      const response = await handleRequest(
        new Request("http://localhost/admin/event/1", {
          headers: { cookie: cookie || "" },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test Event");
    });
  });

  describe("GET /ticket/:id", () => {
    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(makeRequest("/ticket/999"));
      expect(response.status).toBe(404);
    });

    test("shows ticket page for existing event", async () => {
      await createEvent("Test Event", "Description", 50, "https://example.com");
      const response = await handleRequest(makeRequest("/ticket/1"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test Event");
      expect(html).toContain("Reserve Ticket");
    });
  });

  describe("POST /ticket/:id", () => {
    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        makeFormRequest("/ticket/999", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("validates required fields", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        makeFormRequest("/ticket/1", { name: "", email: "" }),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Name and email are required");
    });

    test("validates name is required", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        makeFormRequest("/ticket/1", {
          name: "   ",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("validates email is required", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        makeFormRequest("/ticket/1", { name: "John", email: "   " }),
      );
      expect(response.status).toBe(400);
    });

    test("creates attendee and redirects to thank you page", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com/thanks");
      const response = await handleRequest(
        makeFormRequest("/ticket/1", {
          name: "John Doe",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("rejects when event is full", async () => {
      await createEvent("Event", "Desc", 1, "https://example.com");
      await handleRequest(
        makeFormRequest("/ticket/1", {
          name: "John",
          email: "john@example.com",
        }),
      );

      const response = await handleRequest(
        makeFormRequest("/ticket/1", {
          name: "Jane",
          email: "jane@example.com",
        }),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("event is now full");
    });

    test("returns 404 for unsupported method on ticket route", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        new Request("http://localhost/ticket/1", { method: "PUT" }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      const response = await handleRequest(makeRequest("/unknown/path"));
      expect(response.status).toBe(404);
    });
  });

  describe("session expiration", () => {
    test("nonexistent session shows login page", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/", {
          headers: { cookie: "session=nonexistent" },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Login");
    });

    test("expired session is deleted and shows login page", async () => {
      // Add an expired session directly to DB
      await createSession("expired-token", Date.now() - 1000);

      const response = await handleRequest(
        new Request("http://localhost/admin/", {
          headers: { cookie: "session=expired-token" },
        }),
      );
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
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const token = cookie.split("=")[1]?.split(";")[0] || "";

      expect(token).not.toBe("");
      const sessionBefore = await getSession(token);
      expect(sessionBefore).not.toBeNull();

      // Now logout
      const logoutResponse = await handleRequest(
        new Request("http://localhost/admin/logout", {
          headers: { cookie: `session=${token}` },
        }),
      );
      expect(logoutResponse.status).toBe(302);

      // Verify session was deleted
      const sessionAfter = await getSession(token);
      expect(sessionAfter).toBeNull();
    });
  });

  describe("full login flow with cookie", () => {
    test("login returns Set-Cookie header with session token", async () => {
      const password = await getOrCreateAdminPassword();
      const response = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );

      expect(response.status).toBe(302);
      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain("session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Path=/");
    });

    test("can access admin dashboard with session cookie", async () => {
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );

      // Extract just the session token from Set-Cookie
      const setCookie = loginResponse.headers.get("set-cookie") || "";
      const token = setCookie.split("=")[1]?.split(";")[0] || "";
      expect(token.length).toBe(32);

      // Use the token in a Cookie header
      const dashboardResponse = await handleRequest(
        new Request("http://localhost/admin/", {
          headers: { cookie: `session=${token}` },
        }),
      );

      expect(dashboardResponse.status).toBe(200);
      const html = await dashboardResponse.text();
      expect(html).toContain("Admin Dashboard");
    });

    test("can create event with session cookie and see it in dashboard", async () => {
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );

      const setCookie = loginResponse.headers.get("set-cookie") || "";
      const token = setCookie.split("=")[1]?.split(";")[0] || "";

      // Create an event
      const createResponse = await handleRequest(
        makeFormRequest(
          "/admin/event",
          {
            name: "My Test Event",
            description: "A test event",
            max_attendees: "100",
            thank_you_url: "https://example.com/thanks",
          },
          `session=${token}`,
        ),
      );

      expect(createResponse.status).toBe(302);

      // Verify event shows up in dashboard
      const dashboardResponse = await handleRequest(
        new Request("http://localhost/admin/", {
          headers: { cookie: `session=${token}` },
        }),
      );

      expect(dashboardResponse.status).toBe(200);
      const html = await dashboardResponse.text();
      expect(html).toContain("My Test Event");
    });

    test("without cookie, admin dashboard shows login page", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/"),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Login");
      expect(html).not.toContain("Admin Dashboard");
    });

    test("with invalid cookie, admin dashboard shows login page", async () => {
      const response = await handleRequest(
        new Request("http://localhost/admin/", {
          headers: { cookie: "session=invalid-token-12345" },
        }),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Login");
    });
  });
});
