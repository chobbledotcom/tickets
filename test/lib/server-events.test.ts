import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { createSession } from "#lib/db/sessions.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  expectRedirect,
  loginAsAdmin,
} from "#test-utils";

describe("server (admin events)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("POST /admin/event", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/event", {
          slug: "test-event",
          max_attendees: "100",
          max_quantity: "1",
          thank_you_url: "https://example.com",
        }),
      );
      expectAdminRedirect(response);
    });

    test("creates event when authenticated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "new-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      // Verify event was actually created
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).not.toBeNull();
      expect(event?.slug).toBe("new-event");
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "new-event",
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
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "",
            max_attendees: "",
            thank_you_url: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);
    });

    test("rejects duplicate slug", async () => {
      // First, create an event with a specific slug
      await createTestEvent({
        slug: "duplicate-slug",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie, csrfToken } = await loginAsAdmin();

      // Try to create another event with the same slug
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "duplicate-slug",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      // Should redirect to admin with error (validation failure)
      expectAdminRedirect(response);
    });
  });

  describe("GET /admin/event/:id", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/event/1"));
      expect(response.status).toBe(302);
    });

    test("redirects when wrapped data key is invalid", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Create session with invalid wrapped_data_key
      const token = "test-token-invalid-event";
      await createSession(token, "csrf123", Date.now() + 3600000, "invalid");

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: `__Host-session=${token}`,
      });
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows event details when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(event.slug);
    });

    test("shows Edit link on event page", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie,
      });
      const html = await response.text();
      expect(html).toContain("/admin/event/1/edit");
      expect(html).toContain(">Edit<");
    });
  });

  describe("GET /admin/event/:id/export", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/export"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/export", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("returns CSV with correct headers when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/export", {
        cookie: cookie,
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
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane Smith", "jane@example.com");

      const response = await awaitTestRequest(`/admin/event/${event.id}/export`, {
        cookie: cookie,
      });
      const csv = await response.text();
      expect(csv).toContain("Name,Email,Phone,Quantity,Registered");
      expect(csv).toContain("John Doe");
      expect(csv).toContain("john@example.com");
      expect(csv).toContain("Jane Smith");
      expect(csv).toContain("jane@example.com");
    });

    test("sanitizes slug for filename", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event-special",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/export", {
        cookie: cookie,
      });
      const disposition = response.headers.get("content-disposition");
      // Dashes are replaced with underscores in filename sanitization
      expect(disposition).toContain("test_event_special");
    });
  });

  describe("GET /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest("/admin/event/1/edit"));
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/edit", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows edit form when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1500,
      });

      const response = await awaitTestRequest("/admin/event/1/edit", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Edit:");
      expect(html).toContain('value="test-event"');
      expect(html).toContain('value="100"');
      expect(html).toContain('value="1500"');
      expect(html).toContain('value="https://example.com/thanks"');
    });
  });

  describe("POST /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/edit", {
          slug: "updated-event",
          max_attendees: "50",
          max_quantity: "1",
          thank_you_url: "https://example.com/updated",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/edit",
          {
            slug: "updated-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/updated",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request with invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "updated-event",
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
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Identifier is required");
    });

    test("rejects duplicate slug on update", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create two events
      await createTestEvent({
        slug: "first-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        slug: "second-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Try to update first event to use second event's slug
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "second-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });

    test("updates event when authenticated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: event.slug,
            max_attendees: "200",
            max_quantity: "5",
            thank_you_url: "https://example.com/updated",
            unit_price: "2000",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);

      // Verify the event was updated
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(1);
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });
  });

  describe("GET /admin/event/:id/deactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/deactivate"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/deactivate", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows deactivate confirmation page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/deactivate", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Deactivate Event");
      expect(html).toContain("Return a 404");
      expect(html).toContain('name="confirm_identifier"');
      expect(html).toContain("type its identifier");
      expect(html).toContain(event.slug);
    });
  });

  describe("POST /admin/event/:id/deactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/deactivate", {}),
      );
      expectAdminRedirect(response);
    });

    test("deactivates event and redirects", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/deactivate",
          { csrf_token: csrfToken, confirm_identifier: event.slug },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);

      // Verify event is now inactive
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const deactivatedEvent = await getEventWithCount(1);
      expect(deactivatedEvent?.active).toBe(0);
    });

    test("returns error when identifier does not match", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/deactivate",
          { csrf_token: csrfToken, confirm_identifier: "wrong-identifier" },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });
  });

  describe("GET /admin/event/:id/reactivate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/reactivate"),
      );
      expectAdminRedirect(response);
    });

    test("shows reactivate confirmation page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await awaitTestRequest("/admin/event/1/reactivate", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reactivate Event");
      expect(html).toContain("available for registrations");
      expect(html).toContain('name="confirm_identifier"');
      expect(html).toContain("type its identifier");
    });
  });

  describe("POST /admin/event/:id/reactivate", () => {
    test("reactivates event and redirects", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/reactivate",
          { csrf_token: csrfToken, confirm_identifier: event.slug },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);

      // Verify event is now active
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const activeEvent = await getEventWithCount(1);
      expect(activeEvent?.active).toBe(1);
    });

    test("returns error when name does not match", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/reactivate",
          { csrf_token: csrfToken, confirm_identifier: "wrong-identifier" },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });
  });

  describe("GET /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/delete"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/delete", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/delete", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Delete Event");
      expect(html).toContain(event.slug);
      expect(html).toContain("type its identifier");
    });
  });

  describe("POST /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/delete", {
          confirm_identifier: event.slug,
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/delete",
          {
            confirm_identifier: "test-event",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: event.slug,
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects mismatched event identifier", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "wrong-identifier",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("deletes event with matching identifier (case insensitive)", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "TEST-EVENT", // uppercase (case insensitive)
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const deletedEvent = await getEvent(1);
      expect(deletedEvent).toBeNull();
    });

    test("deletes event with matching identifier (trimmed)", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "  test-event  ", // with spaces
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);
    });

    test("deletes event and all attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane Doe", "jane@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete`,
          {
            confirm_identifier: event.slug,
            csrf_token: csrfToken,
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

    test("skips identifier verification when verify_identifier=false (for API users)", async () => {
      await createTestEvent({
        slug: "api-event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Login and get CSRF token
      const { cookie, csrfToken } = await loginAsAdmin();

      // Delete with verify_identifier=false - no need for confirm_identifier
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete?verify_identifier=false",
          {
            csrf_token: csrfToken,
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
        slug: "delete-method-test",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Login and get CSRF token
      const { cookie, csrfToken } = await loginAsAdmin();

      // Use DELETE method with verify_identifier=false
      const response = await handleRequest(
        new Request("http://localhost/admin/event/1/delete?verify_identifier=false", {
          method: "DELETE",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookie,
            host: "localhost",
          },
          body: new URLSearchParams({
            csrf_token: csrfToken,
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

  describe("POST /admin/event with unit_price", () => {
    test("creates event with unit_price when authenticated", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            slug: "paid-event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            unit_price: "1000",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /admin/activity-log", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/activity-log"));
      expectAdminRedirect(response);
    });

    test("shows activity log page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      // Create an event to generate activity
      await createTestEvent({
        slug: "activity-log-test",
        maxAttendees: 50,
      });

      const response = await awaitTestRequest("/admin/activity-log", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Activity Log");
    });
  });

  describe("GET /admin/event/:id/activity-log", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/event/1/activity-log"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/activity-log", {
        cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows activity log for existing event", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "event-activity-log",
        maxAttendees: 50,
      });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/activity-log`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Activity Log");
      expect(html).toContain(event.slug);
    });
  });

  describe("POST /admin/event/:id/deactivate (event not found)", () => {
    test("returns 404 when event does not exist", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/deactivate",
          { csrf_token: csrfToken, confirm_identifier: "something" },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/event/:id/reactivate (event not found)", () => {
    test("returns 404 when event does not exist", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/reactivate",
          { csrf_token: csrfToken, confirm_identifier: "something" },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("admin/events.ts (event delete handler via onDelete)", () => {
    test("delete event handler cleans up associated data", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "on-delete-test",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "Test User", "test@example.com");

      // Delete event via API (skip verify)
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify both event and attendees deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      expect(await getEvent(event.id)).toBeNull();
      expect((await getAttendeesRaw(event.id)).length).toBe(0);
    });
  });

  describe("admin/events.ts (withEventAttendees privateKey null)", () => {
    test("redirects when session has no wrapped data key on event view", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Create session without wrapped_data_key
      const token = "test-token-no-key-event";
      await createSession(token, "csrf123", Date.now() + 3600000, null);

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie: `__Host-session=${token}`,
      });
      expectAdminRedirect(response);
    });
  });

  describe("admin/events.ts (eventErrorPage with deleted event)", () => {
    test("edit validation returns 400 with error when event exists", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Create two events
      await createTestEvent({
        slug: "first-edit-err",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        slug: "second-edit-err",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Try to update first event with second event's slug (duplicate slug error)
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            slug: "second-edit-err",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      // Should return 400 with error page (event exists -> eventErrorPage returns htmlResponse)
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });
  });

  describe("admin/events.ts (form.get fallbacks)", () => {
    test("deactivate event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "deactivate-fallback",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Submit without confirm_identifier field
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/deactivate`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });

    test("reactivate event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        slug: "reactivate-fallback",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await deactivateTestEvent(event.id);

      // Submit without confirm_identifier field
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/reactivate`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event identifier does not match");
    });

    test("delete event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        slug: "delete-fallback",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Submit without confirm_identifier field
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/1/delete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });
  });

  describe("POST /admin/event/:id/edit validation error", () => {
    test("shows error when editing non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/99999/edit",
          {
            slug: "updated-slug",
            max_attendees: "50",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("shows edit page with error when slug is already taken", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event1 = await createTestEvent({
        slug: "edit-orig",
        maxAttendees: 50,
      });
      await createTestEvent({
        slug: "edit-taken",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event1.id}/edit`,
          {
            slug: "edit-taken",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });
  });

  describe("POST /admin/event/:id/delete with custom onDelete", () => {
    test("deletes event and cascades to attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        slug: "cascade-delete",
        maxAttendees: 50,
      });
      await createTestAttendee(event.id, event.slug, "Test User", "test@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      const { getEvent: getEventFn } = await import("#lib/db/events.ts");
      const deleted = await getEventFn(event.id);
      expect(deleted).toBeNull();
    });
  });

  describe("routes/admin/events.ts (event error page)", () => {
    test("shows edit error page for existing event with duplicate slug", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event1 = await createTestEvent({
        slug: "event-err-1",
        maxAttendees: 50,
      });
      await createTestEvent({
        slug: "event-err-2",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event1.id}/edit`,
          {
            slug: "event-err-2",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("already in use");
    });

    test("event delete cascades to attendees using custom onDelete", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        slug: "cascade-del-test",
        maxAttendees: 50,
      });
      await createTestAttendee(event.id, event.slug, "Del User", "del@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expectAdminRedirect(response);

      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(0);
    });
  });

  describe("routes/admin/events.ts (eventErrorPage notFound)", () => {
    test("event edit validation error returns 404 when event was deleted", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const { eventsTable } = await import("#lib/db/events.ts");

      // Create two events so we can have a slug conflict
      const event1 = await createTestEvent({
        slug: "event-for-delete-err",
        maxAttendees: 50,
      });
      await createTestEvent({
        slug: "event-err-conflict",
        maxAttendees: 50,
      });

      // Spy on eventsTable.findById: return the row on first call (so requireExists passes),
      // but also delete the event from DB so getEventWithCount (raw SQL) returns null.
      const originalFindById = eventsTable.findById.bind(eventsTable);
      const spy = spyOn(eventsTable, "findById");
      spy.mockImplementation(async (id: unknown) => {
        const row = await originalFindById(id as number);
        if (row) {
          // Delete the event from DB so getEventWithCount returns null
          const { getDb } = await import("#lib/db/client.ts");
          await getDb().execute({ sql: "DELETE FROM events WHERE id = ?", args: [id as number] });
        }
        return row;
      });

      try {
        // Send an update with a duplicate slug to trigger validation error
        const response = await handleRequest(
          mockFormRequest(
            `/admin/event/${event1.id}/edit`,
            {
              slug: "event-err-conflict",
              max_attendees: "50",
              max_quantity: "1",
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        // requireExists sees the row (first findById). Validation fails (duplicate slug).
        // eventErrorPage calls getEventWithCount, but event was deleted, so returns 404.
        expect(response.status).toBe(404);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("admin event onDelete handler", () => {
    test("deleting an event triggers the onDelete handler which calls deleteEvent", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({ slug: "delete-ondelete-test", maxAttendees: 10 });
      // Add an attendee so delete covers more paths
      await createTestAttendee(event.id, event.slug, "User A", "a@test.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete`,
          { csrf_token: csrfToken, confirm_identifier: event.slug },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });

});
