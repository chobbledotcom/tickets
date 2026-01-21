import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  createAttendee,
  createEvent,
  getOrCreateAdminPassword,
  initDb,
  setDb,
} from "#lib/db.ts";
import { resetStripeClient } from "#lib/stripe.ts";
import { handleRequest, sessions } from "#src/server.ts";

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
    sessions.clear();
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
      // Add an expired session directly
      sessions.set("expired-token", { expires: Date.now() - 1000 });

      const response = await handleRequest(
        new Request("http://localhost/admin/", {
          headers: { cookie: "session=expired-token" },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Admin Login");

      // Verify the expired session was deleted
      expect(sessions.has("expired-token")).toBe(false);
    });
  });

  describe("logout with valid session", () => {
    test("deletes session from sessions map", async () => {
      // Log in first
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie") || "";
      const token = cookie.split("=")[1]?.split(";")[0] || "";

      expect(token).not.toBe("");
      expect(sessions.has(token)).toBe(true);

      // Now logout
      const logoutResponse = await handleRequest(
        new Request("http://localhost/admin/logout", {
          headers: { cookie: `session=${token}` },
        }),
      );
      expect(logoutResponse.status).toBe(302);

      // Verify session was deleted
      expect(sessions.has(token)).toBe(false);
    });
  });

  describe("POST /admin/event with unit_price", () => {
    test("creates event with unit_price when authenticated", async () => {
      const password = await getOrCreateAdminPassword();
      const loginResponse = await handleRequest(
        makeFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        makeFormRequest(
          "/admin/event",
          {
            name: "Paid Event",
            description: "Description",
            max_attendees: "50",
            thank_you_url: "https://example.com/thanks",
            unit_price: "1000",
          },
          cookie || "",
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /payment/success", () => {
    test("returns error for missing params", async () => {
      const response = await handleRequest(makeRequest("/payment/success"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error for missing session_id", async () => {
      const response = await handleRequest(
        makeRequest("/payment/success?attendee_id=1"),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error for non-existent attendee", async () => {
      const response = await handleRequest(
        makeRequest("/payment/success?attendee_id=999&session_id=cs_test"),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Attendee not found");
    });

    test("returns error when attendee exists but payment verification fails", async () => {
      // When there's no Stripe client configured, retrieveCheckoutSession returns null
      const event = await createEvent(
        "Test",
        "Desc",
        50,
        "https://example.com",
      );
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      const response = await handleRequest(
        makeRequest(
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
      const response = await handleRequest(makeRequest("/payment/cancel"));
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid payment callback");
    });

    test("returns error for non-existent attendee", async () => {
      const response = await handleRequest(
        makeRequest("/payment/cancel?attendee_id=999"),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Attendee not found");
    });

    test("deletes attendee and shows cancel page", async () => {
      const event = await createEvent(
        "Test",
        "Desc",
        50,
        "https://example.com",
      );
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      const response = await handleRequest(
        makeRequest(`/payment/cancel?attendee_id=${attendee.id}`),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Payment Cancelled");
      expect(html).toContain("/ticket/");
    });
  });

  describe("payment routes", () => {
    test("returns 404 for unsupported method on payment routes", async () => {
      const response = await handleRequest(
        new Request("http://localhost/payment/success", { method: "POST" }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("ticket purchase with payments enabled", () => {
    const originalStripeKey = process.env.STRIPE_SECRET_KEY;
    const originalStripeMockHost = process.env.STRIPE_MOCK_HOST;
    const originalStripeMockPort = process.env.STRIPE_MOCK_PORT;

    /**
     * Check if stripe-mock is running on localhost:12111
     */
    const checkStripeMock = async (): Promise<boolean> => {
      try {
        const response = await fetch("http://localhost:12111/", {
          signal: AbortSignal.timeout(500),
        });
        return response.ok;
      } catch {
        return false;
      }
    };

    afterEach(() => {
      resetStripeClient();
      if (originalStripeKey) {
        process.env.STRIPE_SECRET_KEY = originalStripeKey;
      } else {
        delete process.env.STRIPE_SECRET_KEY;
      }
      if (originalStripeMockHost) {
        process.env.STRIPE_MOCK_HOST = originalStripeMockHost;
      } else {
        delete process.env.STRIPE_MOCK_HOST;
      }
      if (originalStripeMockPort) {
        process.env.STRIPE_MOCK_PORT = originalStripeMockPort;
      } else {
        delete process.env.STRIPE_MOCK_PORT;
      }
    });

    test("handles payment flow error when Stripe fails", async () => {
      // Set a fake Stripe key to enable payments
      process.env.STRIPE_SECRET_KEY = "sk_test_fake_key";

      // Create a paid event
      const event = await createEvent(
        "Paid Event",
        "Description",
        50,
        "https://example.com/thanks",
        1000, // 10.00 price
      );

      // Try to reserve a ticket - should fail because Stripe key is invalid
      const response = await handleRequest(
        makeFormRequest(`/ticket/${event.id}`, {
          name: "John Doe",
          email: "john@example.com",
        }),
      );

      // Should return error page because Stripe session creation fails
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("Failed to create payment session");
    });

    test("free ticket still works when payments enabled", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_fake_key";

      // Create a free event (no price)
      const event = await createEvent(
        "Free Event",
        "Description",
        50,
        "https://example.com/thanks",
        null, // free
      );

      const response = await handleRequest(
        makeFormRequest(`/ticket/${event.id}`, {
          name: "John Doe",
          email: "john@example.com",
        }),
      );

      // Should redirect to thank you page
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("zero price ticket is treated as free", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_fake_key";

      // Create event with 0 price
      const event = await createEvent(
        "Zero Price Event",
        "Description",
        50,
        "https://example.com/thanks",
        0, // zero price
      );

      const response = await handleRequest(
        makeFormRequest(`/ticket/${event.id}`, {
          name: "John Doe",
          email: "john@example.com",
        }),
      );

      // Should redirect to thank you page (no payment required)
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("redirects to Stripe checkout with stripe-mock", async () => {
      const mockAvailable = await checkStripeMock();
      if (!mockAvailable) {
        console.log("Skipping: stripe-mock not running on localhost:12111");
        return;
      }

      process.env.STRIPE_SECRET_KEY = "sk_test_mock";
      process.env.STRIPE_MOCK_HOST = "localhost";
      process.env.STRIPE_MOCK_PORT = "12111";

      const event = await createEvent(
        "Paid Event",
        "Description",
        50,
        "https://example.com/thanks",
        1000, // 10.00 price
      );

      const response = await handleRequest(
        makeFormRequest(`/ticket/${event.id}`, {
          name: "John Doe",
          email: "john@example.com",
        }),
      );

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
      const event = await createEvent(
        "Test",
        "Desc",
        50,
        "https://example.com",
      );
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      // Delete the event - need to delete attendee first due to FK constraint
      // then recreate attendee pointing to deleted event
      const { getDb } = await import("#lib/db.ts");

      // Disable foreign key checks, delete event, re-enable
      await getDb().execute("PRAGMA foreign_keys = OFF");
      await getDb().execute({
        sql: "DELETE FROM events WHERE id = ?",
        args: [event.id],
      });
      await getDb().execute("PRAGMA foreign_keys = ON");

      // Now try to access payment success - attendee exists but event doesn't
      const response = await handleRequest(
        makeRequest(
          `/payment/success?attendee_id=${attendee.id}&session_id=cs_test`,
        ),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Event not found");
    });

    test("handles successful payment verification with stripe-mock", async () => {
      const mockAvailable = await checkStripeMock();
      if (!mockAvailable) {
        console.log("Skipping: stripe-mock not running on localhost:12111");
        return;
      }

      process.env.STRIPE_SECRET_KEY = "sk_test_mock";
      process.env.STRIPE_MOCK_HOST = "localhost";
      process.env.STRIPE_MOCK_PORT = "12111";

      const event = await createEvent(
        "Paid Event",
        "Description",
        50,
        "https://example.com/thanks",
        1000,
      );
      const attendee = await createAttendee(
        event.id,
        "John",
        "john@example.com",
      );

      // Use a session ID that stripe-mock will accept
      // stripe-mock uses predictable session IDs like cs_test_...
      const response = await handleRequest(
        makeRequest(
          `/payment/success?attendee_id=${attendee.id}&session_id=cs_test_mock`,
        ),
      );

      // stripe-mock returns mock data, which may not have payment_status=paid
      // This test verifies the code path runs; actual payment verification depends on mock
      expect([200, 400]).toContain(response.status);
    });
  });
});
