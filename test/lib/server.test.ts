import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createAttendee,
  createEvent,
  createSession,
  getSession,
  setSetting,
} from "#lib/db.ts";
import { resetStripeClient } from "#lib/stripe.ts";
import { handleRequest } from "#src/server.ts";
import {
  createTestDb,
  createTestDbWithSetup,
  mockCrossOriginFormRequest,
  mockFormRequest,
  mockRequest,
  resetDb,
  TEST_ADMIN_PASSWORD,
} from "#test-utils";

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
      const response = await handleRequest(
        new Request("http://localhost/health", { method: "POST" }),
      );
      expect(response.status).toBe(404);
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
      TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", {
          password: TEST_ADMIN_PASSWORD,
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
      expect(html).toContain("Invalid password");
    });

    test("accepts correct password and sets cookie", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const response = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
      expect(response.headers.get("set-cookie")).toContain("session=");
    });
  });

  describe("GET /admin/logout", () => {
    test("clears session and redirects", async () => {
      const response = await handleRequest(mockRequest("/admin/logout"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });
  });

  describe("POST /admin/event", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/event", {
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
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        mockFormRequest(
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

    test("redirects to dashboard on validation failure", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            name: "",
            description: "",
            max_attendees: "",
            thank_you_url: "",
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
      const response = await handleRequest(mockRequest("/admin/event/1"));
      expect(response.status).toBe(302);
    });

    test("returns 404 for non-existent event", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
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
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
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

    test("shows Edit link on event page", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createEvent("Test Event", "Desc", 100, "https://example.com");

      const response = await handleRequest(
        new Request("http://localhost/admin/event/1", {
          headers: { cookie: cookie || "" },
        }),
      );
      const html = await response.text();
      expect(html).toContain("/admin/event/1/edit");
      expect(html).toContain("Edit Event");
    });
  });

  describe("GET /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createEvent("Test Event", "Desc", 100, "https://example.com");
      const response = await handleRequest(mockRequest("/admin/event/1/edit"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });

    test("returns 404 for non-existent event", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        new Request("http://localhost/admin/event/999/edit", {
          headers: { cookie: cookie || "" },
        }),
      );
      expect(response.status).toBe(404);
    });

    test("shows edit form when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createEvent(
        "Test Event",
        "Test Description",
        100,
        "https://example.com/thanks",
        1500,
      );

      const response = await handleRequest(
        new Request("http://localhost/admin/event/1/edit", {
          headers: { cookie: cookie || "" },
        }),
      );
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
      await createEvent("Test", "Desc", 100, "https://example.com");
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/edit", {
          name: "Updated",
          description: "Updated Desc",
          max_attendees: "50",
          thank_you_url: "https://example.com/updated",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });

    test("returns 404 for non-existent event", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/edit",
          {
            name: "Updated",
            description: "Updated Desc",
            max_attendees: "50",
            thank_you_url: "https://example.com/updated",
          },
          cookie || "",
        ),
      );
      expect(response.status).toBe(404);
    });

    test("validates required fields", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      await createEvent("Test", "Desc", 100, "https://example.com");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            name: "",
            description: "Desc",
            max_attendees: "50",
            thank_you_url: "https://example.com",
          },
          cookie || "",
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
      const cookie = loginResponse.headers.get("set-cookie");

      await createEvent(
        "Original",
        "Original Desc",
        100,
        "https://example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            name: "Updated Event",
            description: "Updated Description",
            max_attendees: "200",
            thank_you_url: "https://example.com/updated",
            unit_price: "2000",
          },
          cookie || "",
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/event/1");

      // Verify the event was updated
      const { getEventWithCount } = await import("#lib/db.ts");
      const updated = await getEventWithCount(1);
      expect(updated?.name).toBe("Updated Event");
      expect(updated?.description).toBe("Updated Description");
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });
  });

  describe("GET /ticket/:id", () => {
    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(mockRequest("/ticket/999"));
      expect(response.status).toBe(404);
    });

    test("shows ticket page for existing event", async () => {
      await createEvent("Test Event", "Description", 50, "https://example.com");
      const response = await handleRequest(mockRequest("/ticket/1"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Test Event");
      expect(html).toContain("Reserve Ticket");
    });
  });

  describe("POST /ticket/:id", () => {
    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        mockFormRequest("/ticket/999", {
          name: "John",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("validates required fields", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        mockFormRequest("/ticket/1", { name: "", email: "" }),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Your Name is required");
    });

    test("validates name is required", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        mockFormRequest("/ticket/1", {
          name: "   ",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(400);
    });

    test("validates email is required", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        mockFormRequest("/ticket/1", { name: "John", email: "   " }),
      );
      expect(response.status).toBe(400);
    });

    test("creates attendee and redirects to thank you page", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com/thanks");
      const response = await handleRequest(
        mockFormRequest("/ticket/1", {
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
        mockFormRequest("/ticket/1", {
          name: "John",
          email: "john@example.com",
        }),
      );

      const response = await handleRequest(
        mockFormRequest("/ticket/1", {
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
      const response = await handleRequest(mockRequest("/unknown/path"));
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
      // Add an expired session directly to the database
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

  describe("POST /admin/event with unit_price", () => {
    test("creates event with unit_price when authenticated", async () => {
      const password = TEST_ADMIN_PASSWORD;
      const loginResponse = await handleRequest(
        mockFormRequest("/admin/login", { password }),
      );
      const cookie = loginResponse.headers.get("set-cookie");

      const response = await handleRequest(
        mockFormRequest(
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

    test("returns error for non-existent attendee", async () => {
      const response = await handleRequest(
        mockRequest("/payment/cancel?attendee_id=999"),
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
        mockRequest(`/payment/cancel?attendee_id=${attendee.id}`),
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
    // These tests require stripe-mock running on localhost:12111
    // STRIPE_MOCK_HOST/PORT are set in test/setup.ts
    // We use CONFIG_KEYS.STRIPE_SECRET_KEY in database instead of env var

    afterEach(() => {
      resetStripeClient();
    });

    test("handles payment flow error when Stripe fails", async () => {
      // Set a fake Stripe key to enable payments (in database)
      await setSetting("stripe_key", "sk_test_fake_key");

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
        mockFormRequest(`/ticket/${event.id}`, {
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
      await setSetting("stripe_key", "sk_test_fake_key");

      // Create a free event (no price)
      const event = await createEvent(
        "Free Event",
        "Description",
        50,
        "https://example.com/thanks",
        null, // free
      );

      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.id}`, {
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
      await setSetting("stripe_key", "sk_test_fake_key");

      // Create event with 0 price
      const event = await createEvent(
        "Zero Price Event",
        "Description",
        50,
        "https://example.com/thanks",
        0, // zero price
      );

      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.id}`, {
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
      await setSetting("stripe_key", "sk_test_mock");

      const event = await createEvent(
        "Paid Event",
        "Description",
        50,
        "https://example.com/thanks",
        1000, // 10.00 price
      );

      const response = await handleRequest(
        mockFormRequest(`/ticket/${event.id}`, {
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
        mockRequest(
          `/payment/success?attendee_id=${attendee.id}&session_id=cs_test`,
        ),
      );
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Event not found");
    });

    test("handles successful payment verification with stripe-mock", async () => {
      await setSetting("stripe_key", "sk_test_mock");

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

      // Mock retrieveCheckoutSession to return a paid session
      const stripeModule = await import("#lib/stripe.ts");
      const mockRetrieve = spyOn(stripeModule, "retrieveCheckoutSession");
      mockRetrieve.mockResolvedValue({
        id: "cs_test_paid",
        payment_status: "paid",
        payment_intent: "pi_test_123",
      } as Awaited<ReturnType<typeof stripeModule.retrieveCheckoutSession>>);

      try {
        await setSetting("stripe_key", "sk_test_mock");

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
        const { getAttendee } = await import("#lib/db.ts");
        const updatedAttendee = await getAttendee(attendee.id);
        expect(updatedAttendee?.stripe_payment_id).toBe("pi_test_123");
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
        expect(response.headers.get("location")).toBe("/setup/");
      });

      test("redirects admin to /setup/", async () => {
        const response = await handleRequest(mockRequest("/admin/"));
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/setup/");
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
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            stripe_secret_key: "sk_test_123",
            currency_code: "USD",
          }),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });

      test("POST /setup/ with empty password shows validation error", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "",
            admin_password_confirm: "",
            currency_code: "GBP",
          }),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Admin Password * is required");
      });

      test("POST /setup/ with mismatched passwords shows error", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "different",
            currency_code: "GBP",
          }),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Passwords do not match");
      });

      test("POST /setup/ with short password shows error", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "short",
            admin_password_confirm: "short",
            currency_code: "GBP",
          }),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("at least 8 characters");
      });

      test("POST /setup/ with invalid currency shows error", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "INVALID",
          }),
        );
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain("Currency code must be 3 uppercase letters");
      });

      test("POST /setup/ without stripe key still works", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            stripe_secret_key: "",
            currency_code: "GBP",
          }),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });

      test("POST /setup/ normalizes lowercase currency to uppercase", async () => {
        const response = await handleRequest(
          mockFormRequest("/setup/", {
            admin_password: "mypassword123",
            admin_password_confirm: "mypassword123",
            currency_code: "usd",
          }),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Setup Complete");
      });

      test("PUT /setup/ redirects to /setup/ (unsupported method)", async () => {
        const response = await handleRequest(
          new Request("http://localhost/setup/", { method: "PUT" }),
        );
        // PUT method falls through routeSetup (returns null), then redirects to /setup/
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/setup/");
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
        await createEvent("Event", "Desc", 50, "https://example.com");
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

    describe("Content-Security-Policy frame-ancestors", () => {
      test("non-embeddable pages have frame-ancestors 'none'", async () => {
        const response = await handleRequest(mockRequest("/"));
        expect(response.headers.get("content-security-policy")).toBe(
          "frame-ancestors 'none'",
        );
      });

      test("ticket page does NOT have frame-ancestors restriction", async () => {
        await createEvent("Event", "Desc", 50, "https://example.com");
        const response = await handleRequest(mockRequest("/ticket/1"));
        expect(response.headers.get("content-security-policy")).toBeNull();
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
        await createEvent("Event", "Desc", 50, "https://example.com");
        const response = await handleRequest(mockRequest("/ticket/1"));
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe(
          "strict-origin-when-cross-origin",
        );
      });
    });
  });

  describe("CORS protection", () => {
    test("rejects cross-origin POST requests", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        mockCrossOriginFormRequest("/ticket/1", {
          name: "Attacker",
          email: "attacker@evil.com",
        }),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Cross-origin requests not allowed");
    });

    test("allows same-origin POST requests", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com/thanks");
      const response = await handleRequest(
        mockFormRequest("/ticket/1", {
          name: "John Doe",
          email: "john@example.com",
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("allows GET requests from any origin", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const response = await handleRequest(
        new Request("http://localhost/ticket/1", {
          headers: { origin: "http://evil.com" },
        }),
      );
      expect(response.status).toBe(200);
    });

    test("rejects cross-origin admin login attempts", async () => {
      const response = await handleRequest(
        mockCrossOriginFormRequest("/admin/login", {
          password: TEST_ADMIN_PASSWORD,
        }),
      );
      expect(response.status).toBe(403);
    });

    test("CORS rejection response has security headers", async () => {
      const response = await handleRequest(
        mockCrossOriginFormRequest("/ticket/1", {
          name: "Test",
          email: "test@test.com",
        }),
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("allows same-origin POST with referer header only (no origin)", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com/thanks");
      const body = new URLSearchParams({
        name: "John Doe",
        email: "john@example.com",
      }).toString();
      const response = await handleRequest(
        new Request("http://localhost/ticket/1", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            referer: "http://localhost/ticket/1",
          },
          body,
        }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "https://example.com/thanks",
      );
    });

    test("rejects cross-origin POST with referer header only", async () => {
      await createEvent("Event", "Desc", 50, "https://example.com");
      const body = new URLSearchParams({
        name: "Attacker",
        email: "attacker@evil.com",
      }).toString();
      const response = await handleRequest(
        new Request("http://localhost/ticket/1", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            referer: "http://evil.com/phishing-page",
          },
          body,
        }),
      );
      expect(response.status).toBe(403);
    });
  });
});
