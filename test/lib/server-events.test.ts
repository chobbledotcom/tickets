import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import type { InStatement } from "@libsql/client";
import { logActivity } from "#lib/db/activityLog.ts";
import { getDb } from "#lib/db/client.ts";
import { addDays } from "#lib/dates.ts";
import { today } from "#lib/now.ts";

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
  submitTicketForm,
  updateTestEvent,
} from "#test-utils";
import { nowMs } from "#lib/now.ts";
import { formatCountdown, withCookie } from "#routes/utils.ts";

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
          name: "Test Event",
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
            name: "New Event",
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
      expect(event?.name).toBe("New Event");
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            name: "New Event",
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
            name: "",
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
      // First, create an event with a specific name
      await createTestEvent({
        name: "Duplicate Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie, csrfToken } = await loginAsAdmin();

      // Try to create another event with the same name (generates same slug)
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            name: "Duplicate Event",
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
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(event.name);
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

  describe("GET /admin/event/:id/duplicate", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockRequest("/admin/event/1/duplicate"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/duplicate", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows duplicate form pre-filled with event settings but no name", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        name: "Original Event",
        maxAttendees: 75,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 2000,
        webhookUrl: "https://example.com/webhook",
      });

      const response = await awaitTestRequest("/admin/event/1/duplicate", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Duplicate Event");
      expect(html).toContain("Original Event");
      expect(html).toContain('value="75"');
      expect(html).toContain('value="2000"');
      expect(html).toContain('value="https://example.com/thanks"');
      expect(html).toContain('value="https://example.com/webhook"');
      // Name field should be empty (not pre-filled)
      expect(html).not.toContain('value="Original Event"');
      // Form posts to create endpoint
      expect(html).toContain('action="/admin/event"');
      // Name field has autofocus
      expect(html).toContain("autofocus");
    });

    test("shows Duplicate link on event detail page", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie,
      });
      const html = await response.text();
      expect(html).toContain("/admin/event/1/duplicate");
      expect(html).toContain(">Duplicate<");
    });
  });

  describe("GET /admin/event/:id/in", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest("/admin/event/1/in"));
      expect(response.status).toBe(302);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/in", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows only checked-in attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const checkedInAttendee = await createTestAttendee(event.id, event.slug, "Checked In User", "in@example.com");
      await createTestAttendee(event.id, event.slug, "Not Checked User", "out@example.com");

      // Check in the first attendee
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${checkedInAttendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      const response = await awaitTestRequest(`/admin/event/${event.id}/in`, {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Checked In User");
      expect(html).not.toContain("Not Checked User");
      expect(html).toContain("<strong>Checked In</strong>");
    });
  });

  describe("GET /admin/event/:id/out", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(mockRequest("/admin/event/1/out"));
      expect(response.status).toBe(302);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/out", {
        cookie: cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows only checked-out attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const checkedInAttendee = await createTestAttendee(event.id, event.slug, "Checked In User", "in@example.com");
      await createTestAttendee(event.id, event.slug, "Not Checked User", "out@example.com");

      // Check in the first attendee
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${checkedInAttendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      const response = await awaitTestRequest(`/admin/event/${event.id}/out`, {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Checked In User");
      expect(html).toContain("Not Checked User");
      expect(html).toContain("<strong>Checked Out</strong>");
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

    test("returns CSV with Checked In column", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      // Check in the attendee
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      const response = await awaitTestRequest(`/admin/event/${event.id}/export`, {
        cookie: cookie,
      });
      const csv = await response.text();
      expect(csv).toContain(",Checked In");
      // John Doe is checked in
      expect(csv).toContain("John Doe");
      expect(csv).toContain(",Yes");
    });

    test("sanitizes slug for filename", async () => {
      const { cookie } = await loginAsAdmin();

      await createTestEvent({
        name: "Test Event Special",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/export", {
        cookie: cookie,
      });
      const disposition = response.headers.get("content-disposition");
      // Non-alphanumeric characters are replaced with underscores in filename sanitization
      expect(disposition).toContain("Test_Event_Special");
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

      const event = await createTestEvent({
        name: "Test Event",
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
      expect(html).toContain('value="Test Event"');
      expect(html).toContain('value="100"');
      expect(html).toContain('value="1500"');
      expect(html).toContain('value="https://example.com/thanks"');
      expect(html).toContain(`value="${event.slug}"`);
      expect(html).toContain("Slug");
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
          name: "Updated Event",
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
            name: "Updated Event",
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
            name: "Updated Event",
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
            name: "",
            slug: "test-slug",
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
      expect(html).toContain("Event Name is required");
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
            name: event.name,
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

    test("updates event slug", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        name: "Slug Update Test",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: "Slug Update Test",
            slug: "new-custom-slug",
            max_attendees: "100",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect(`/admin/event/${event.id}`)(response);

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.slug).toBe("new-custom-slug");
    });

    test("normalizes slug on update (spaces, uppercase)", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        name: "Normalize Test",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: "Normalize Test",
            slug: "  My Custom Slug  ",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect(`/admin/event/${event.id}`)(response);

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.slug).toBe("my-custom-slug");
    });

    test("rejects invalid slug characters", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        name: "Invalid Slug Test",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            name: "Invalid Slug Test",
            slug: "invalid_slug!@#",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Slug may only contain lowercase letters, numbers, and hyphens");
    });

    test("rejects duplicate slug used by another event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event1 = await createTestEvent({
        name: "Event One",
        maxAttendees: 50,
      });
      const event2 = await createTestEvent({
        name: "Event Two",
        maxAttendees: 50,
      });

      // Try to change event2's slug to event1's slug
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event2.id}/edit`,
          {
            name: "Event Two",
            slug: event1.slug,
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Slug is already in use by another event");
    });

    test("allows keeping the same slug on update", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        name: "Same Slug Test",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: "Same Slug Test",
            slug: event.slug,
            max_attendees: "100",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect(`/admin/event/${event.id}`)(response);

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.slug).toBe(event.slug);
      expect(updated?.max_attendees).toBe(100);
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
      expect(html).toContain("type its name");
      expect(html).toContain(event.name);
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
          { csrf_token: csrfToken, confirm_identifier: event.name },
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
        name: "Test Event",
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
      expect(html).toContain("Event name does not match");
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
      expect(html).toContain("type its name");
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
          { csrf_token: csrfToken, confirm_identifier: event.name },
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
        name: "Test Event",
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
      expect(html).toContain("Event name does not match");
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
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/delete", {
        cookie: cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Delete Event");
      expect(html).toContain(event.name);
      expect(html).toContain("type its name");
    });
  });

  describe("POST /admin/event/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest("/admin/event/1/delete", {
          confirm_identifier: event.name,
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
            confirm_identifier: "Test Event",
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
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: event.name,
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
        name: "Test Event",
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
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "TEST EVENT", // uppercase (case insensitive)
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
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          {
            confirm_identifier: "  Test Event  ", // with spaces
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
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane Doe", "jane@example.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete`,
          {
            confirm_identifier: event.name,
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
        name: "API Event",
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
        name: "Delete Method Test",
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
            name: "Paid Event",
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

  describe("GET /admin/log", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/log"));
      expectAdminRedirect(response);
    });

    test("shows log page when authenticated", async () => {
      const { cookie } = await loginAsAdmin();

      // Create an event to generate activity
      await createTestEvent({
        name: "Log Test",
        maxAttendees: 50,
      });

      const response = await awaitTestRequest("/admin/log", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Log");
    });

    test("shows truncation message when more than 200 entries", async () => {
      const { cookie } = await loginAsAdmin();

      // Create 201 log entries to trigger truncation
      for (let i = 0; i < 201; i++) {
        await logActivity(`Action ${i}`);
      }

      const response = await awaitTestRequest("/admin/log", { cookie });
      const html = await response.text();
      expect(html).toContain("Showing the most recent 200 entries");
    });
  });

  describe("GET /admin/event/:id/log", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/event/1/log"),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest("/admin/event/999/log", {
        cookie,
      });
      expect(response.status).toBe(404);
    });

    test("shows log for existing event", async () => {
      const { cookie } = await loginAsAdmin();

      const event = await createTestEvent({
        name: "Event Log",
        maxAttendees: 50,
      });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/log`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Log");
      expect(html).toContain(event.name);
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
        name: "On Delete Test",
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

  describe("admin/events.ts (eventErrorPage with deleted event)", () => {
    test("edit validation returns 400 with error when event exists", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        name: "First Edit Err",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Submit with empty name to trigger validation error
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            name: "",
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
      expect(html).toContain("Event Name is required");
    });
  });

  describe("admin/events.ts (form.get fallbacks)", () => {
    test("deactivate event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        name: "Deactivate Fallback",
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
      expect(html).toContain("Event name does not match");
    });

    test("reactivate event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const event = await createTestEvent({
        name: "Reactivate Fallback",
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
      expect(html).toContain("Event name does not match");
    });

    test("delete event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      await createTestEvent({
        name: "Delete Fallback",
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
            name: "Updated Name",
            max_attendees: "50",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("shows edit page with error when name is empty", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event1 = await createTestEvent({
        name: "Edit Orig",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event1.id}/edit`,
          {
            name: "",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event Name is required");
    });
  });

  describe("POST /admin/event/:id/delete with custom onDelete", () => {
    test("deletes event and cascades to attendees", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        name: "Cascade Delete",
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
    test("shows edit error page for existing event with validation error", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event1 = await createTestEvent({
        name: "Event Err 1",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event1.id}/edit`,
          {
            name: "",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event Name is required");
    });

    test("event delete cascades to attendees using custom onDelete", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        name: "Cascade Del Test",
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

      const event1 = await createTestEvent({
        name: "Event For Delete Err",
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
        // Send an update with empty name to trigger validation error
        const response = await handleRequest(
          mockFormRequest(
            `/admin/event/${event1.id}/edit`,
            {
              name: "",
              max_attendees: "50",
              max_quantity: "1",
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        // requireExists sees the row (first findById). Validation fails (empty name).
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
      const event = await createTestEvent({ name: "Delete OnDelete Test", maxAttendees: 10 });
      // Add an attendee so delete covers more paths
      await createTestAttendee(event.id, event.slug, "User A", "a@test.com");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete`,
          { csrf_token: csrfToken, confirm_identifier: event.name },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("slug collision on create", () => {
    test("throws when all slug generation attempts collide", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      // Spy on db.execute to make isSlugTaken always return true
      const db = getDb();
      const originalExecute = db.execute.bind(db);
      const spy = spyOn(db, "execute");
      spy.mockImplementation((query: InStatement) => {
        const sql = typeof query === "string" ? query : query.sql;
        // Intercept the isSlugTaken query
        if (sql.includes("SELECT 1 FROM events WHERE slug_index")) {
          return Promise.resolve({ rows: [{ "1": 1 }], columns: ["1"], rowsAffected: 0, lastInsertRowid: 0n });
        }
        return originalExecute(query);
      });

      try {
        await expect(
          handleRequest(
            mockFormRequest(
              "/admin/event",
              {
                name: "Collision Event",
                max_attendees: "50",
                max_quantity: "1",
                thank_you_url: "https://example.com",
                csrf_token: csrfToken,
              },
              cookie,
            ),
          ),
        ).rejects.toThrow("Failed to generate unique slug after 10 attempts");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("edit event notFound race condition", () => {
    test("returns 404 when event is deleted during edit update", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        name: "Race Condition Event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // handleAdminEventEditPost calls getEventWithCount (raw SQL), then
      // updateResource.update which calls requireExists -> table.findById.
      // We spy on findById to return null, simulating the event being deleted
      // between the initial check and the update.
      const { eventsTable: table } = await import("#lib/db/events.ts");
      const spy = spyOn(table, "findById");
      spy.mockImplementation(() => Promise.resolve(null));

      try {
        const response = await handleRequest(
          mockFormRequest(
            `/admin/event/${event.id}/edit`,
            {
              name: "Updated Name",
              slug: "updated-slug",
              max_attendees: "50",
              max_quantity: "1",
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        expect(response.status).toBe(404);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("closes_at field", () => {
    test("creates event with closes_at timestamp", async () => {
      const closesAt = "2099-06-15T14:30";
      const event = await createTestEvent({ closesAt });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.closes_at).toBe("2099-06-15T14:30:00.000Z");
    });

    test("creates event without closes_at (defaults to null)", async () => {
      const event = await createTestEvent();

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.closes_at).toBeNull();
    });

    test("updates event closes_at", async () => {
      const event = await createTestEvent();
      const closesAt = "2099-12-31T23:59";
      await updateTestEvent(event.id, { closesAt });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });

    test("clears closes_at by setting to empty string", async () => {
      const event = await createTestEvent({ closesAt: "2099-06-15T14:30" });
      await updateTestEvent(event.id, { closesAt: "" });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.closes_at).toBeNull();
    });

    test("admin event detail page shows closes_at with countdown when set", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({ closesAt: "2099-06-15T14:30" });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Registration Closes");
      expect(html).not.toContain("No deadline");
      expect(html).toContain("from now");
    });

    test("admin event detail page shows 'No deadline' when closes_at is null", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("No deadline");
    });

    test("admin event edit page shows closes_at in form", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({ closesAt: "2099-06-15T14:30" });

      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('value="2099-06-15T14:30"');
      expect(html).toContain("Registration Closes At");
    });

    test("admin event detail page shows 'closed' countdown for past closes_at", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({ closesAt: "2024-01-01T00:00" });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("(closed)");
    });

    test("admin event detail page shows days-only countdown", async () => {
      const { cookie } = await loginAsAdmin();
      const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000);
      const closesAt = future.toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("days from now");
    });

    test("admin event detail page shows hours-only countdown", async () => {
      const { cookie } = await loginAsAdmin();
      const future = new Date(Date.now() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000);
      const closesAt = future.toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("hours from now");
    });

    test("admin event detail page shows minutes-only countdown", async () => {
      const { cookie } = await loginAsAdmin();
      const future = new Date(Date.now() + 30 * 60 * 1000);
      const closesAt = future.toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("minute");
    });

    test("formatCountdown shows days and hours", () => {
      const future = new Date(nowMs + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000).toISOString();
      expect(formatCountdown(future)).toBe("3 days and 5 hours from now");
    });

    test("formatCountdown shows only days when no remaining hours", () => {
      const future = new Date(nowMs + 2 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString();
      expect(formatCountdown(future)).toBe("2 days from now");
    });

    test("formatCountdown shows only hours", () => {
      const future = new Date(nowMs + 5 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString();
      expect(formatCountdown(future)).toBe("5 hours from now");
    });

    test("formatCountdown shows minutes when less than an hour", () => {
      const result = formatCountdown(new Date(nowMs + 30 * 60 * 1000).toISOString());
      expect(result).toContain("minute");
      expect(result).toContain("from now");
    });

    test("formatCountdown shows closed for past dates", () => {
      expect(formatCountdown("2024-01-01T00:00:00.000Z")).toBe("closed");
    });

    test("formatCountdown singular forms", () => {
      const future = new Date(nowMs + 1 * 24 * 60 * 60 * 1000 + 1 * 60 * 60 * 1000).toISOString();
      expect(formatCountdown(future)).toBe("1 day and 1 hour from now");
    });

    test("rejects invalid closes_at format", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: event.slug,
            max_attendees: "100",
            max_quantity: "1",
            closes_at: "not-a-date",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Please enter a valid date and time");
    });
  });

  describe("withCookie", () => {
    test("adds a cookie to a response without existing cookies", () => {
      const response = new Response("body", { status: 200 });
      const result = withCookie(response, "session=abc; Path=/");
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });

    test("preserves existing set-cookie headers when adding another", () => {
      const headers = new Headers();
      headers.append("set-cookie", "first=one; Path=/");
      const response = new Response("body", { status: 200, headers });
      const result = withCookie(response, "second=two; Path=/");
      const cookies = result.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      expect(cookies).toContain("first=one; Path=/");
      expect(cookies).toContain("second=two; Path=/");
    });

    test("preserves response status", () => {
      const response = new Response("body", { status: 201 });
      const result = withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(201);
    });
  });

  describe("daily event type", () => {
    test("creates a daily event with custom config", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: '["Monday","Wednesday","Friday"]',
        minimumDaysBefore: 2,
        maximumDaysAfter: 30,
      });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.event_type).toBe("daily");
      expect(saved?.bookable_days).toBe('["Monday","Wednesday","Friday"]');
      expect(saved?.minimum_days_before).toBe(2);
      expect(saved?.maximum_days_after).toBe(30);
    });

    test("creates standard event with default daily config", async () => {
      const event = await createTestEvent();

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.event_type).toBe("standard");
      expect(saved?.bookable_days).toBe('["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]');
      expect(saved?.minimum_days_before).toBe(1);
      expect(saved?.maximum_days_after).toBe(90);
    });

    test("admin event detail page shows Daily type for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: '["Monday","Tuesday"]',
        minimumDaysBefore: 3,
        maximumDaysAfter: 60,
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Event Type");
      expect(html).toContain("Daily");
      expect(html).toContain("Bookable Days");
      expect(html).toContain("Monday,Tuesday");
      expect(html).toContain("Booking Window");
      expect(html).toContain("3 to 60 days");
      expect(html).toContain("Capacity of");
      expect(html).toContain("applies per date");
    });

    test("admin event detail page shows Standard type without daily config", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Event Type");
      expect(html).toContain("Standard");
      expect(html).not.toContain("Bookable Days");
      expect(html).not.toContain("Booking Window");
    });

    test("admin event edit page pre-fills daily config", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: '["Wednesday","Friday"]',
        minimumDaysBefore: 5,
        maximumDaysAfter: 120,
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('value="Wednesday" checked');
      expect(html).toContain('value="Friday" checked');
      expect(html).not.toContain('value="Monday" checked');
      expect(html).toContain('value="5"');
      expect(html).toContain('value="120"');
    });

    test("updates event from standard to daily", async () => {
      const event = await createTestEvent();
      await updateTestEvent(event.id, {
        eventType: "daily",
        bookableDays: '["Saturday","Sunday"]',
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.event_type).toBe("daily");
      expect(updated?.bookable_days).toBe('["Saturday","Sunday"]');
      expect(updated?.minimum_days_before).toBe(0);
      expect(updated?.maximum_days_after).toBe(14);
    });

    test("updates event from daily to standard", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: '["Monday"]',
        minimumDaysBefore: 7,
        maximumDaysAfter: 365,
      });
      await updateTestEvent(event.id, { eventType: "standard" });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.event_type).toBe("standard");
    });

    test("duplicate page pre-fills daily event config", async () => {
      const { cookie } = await loginAsAdmin();
      await createTestEvent({
        eventType: "daily",
        bookableDays: '["Tuesday","Thursday"]',
        minimumDaysBefore: 2,
        maximumDaysAfter: 45,
      });

      const response = await awaitTestRequest("/admin/event/1/duplicate", {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('value="Tuesday" checked');
      expect(html).toContain('value="Thursday" checked');
      expect(html).not.toContain('value="Monday" checked');
      expect(html).toContain('value="2"');
      expect(html).toContain('value="45"');
    });

    test("rejects invalid event_type value", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event",
          {
            name: "Bad Type Event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com",
            event_type: "invalid",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid bookable_days value", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      await createTestEvent({ name: "Edit Target" });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const event = (await getEventWithCount(1))!;

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/edit",
          {
            name: "Edit Target",
            slug: event.slug,
            max_attendees: "50",
            max_quantity: "1",
            event_type: "daily",
            bookable_days: "Funday,Bunday",
            minimum_days_before: "1",
            maximum_days_after: "90",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Invalid day");
    });
  });

  describe("daily event admin view (Phase 4)", () => {
    const validDate1 = addDays(today, 1);
    const validDate2 = addDays(today, 2);

    const createDailyEventWithAttendees = async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      // Create attendees on two different dates via the public form
      await submitTicketForm(event.slug, { name: "User A", email: "a@test.com", date: validDate1 });
      await submitTicketForm(event.slug, { name: "User B", email: "b@test.com", date: validDate1 });
      await submitTicketForm(event.slug, { name: "User C", email: "c@test.com", date: validDate2 });
      return event;
    };

    test("shows date selector dropdown for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<select");
      expect(html).toContain("All dates");
      expect(html).toContain(validDate1);
      expect(html).toContain(validDate2);
    });

    test("shows Date column header for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, { cookie });
      const html = await response.text();
      expect(html).toContain("<th>Date</th>");
    });

    test("does not show Date column for standard events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, { cookie });
      const html = await response.text();
      expect(html).not.toContain("<th>Date</th>");
    });

    test("filters attendees by ?date= parameter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      // Filter to date1 — should show 2 attendees (User A and User B)
      const response = await awaitTestRequest(`/admin/event/${event.id}?date=${validDate1}`, { cookie });
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).toContain("User B");
      expect(html).not.toContain("User C");
    });

    test("filters attendees by ?date= showing other date", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      // Filter to date2 — should show 1 attendee (User C)
      const response = await awaitTestRequest(`/admin/event/${event.id}?date=${validDate2}`, { cookie });
      const html = await response.text();
      expect(html).toContain("User C");
      expect(html).not.toContain("User A");
    });

    test("shows per-date capacity when date filter is active", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}?date=${validDate1}`, { cookie });
      const html = await response.text();
      // Should show "2 / 100" for the 2 attendees on date1
      expect(html).toContain("2 / 100");
      expect(html).toContain("98 remain");
    });

    test("shows total count without date filter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, { cookie });
      const html = await response.text();
      expect(html).toContain("(total)");
      expect(html).toContain("Capacity of");
    });

    test("date filter composes with check-in filter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      // Filter to date1 + checked out — should show both since none are checked in
      const response = await awaitTestRequest(`/admin/event/${event.id}/out?date=${validDate1}`, { cookie });
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).toContain("User B");
      expect(html).not.toContain("User C");
    });

    test("ignores ?date= for standard events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent();
      await createTestAttendee(event.id, event.slug, "Standard User", "std@test.com");

      // Even with ?date= param, standard events show all attendees
      const response = await awaitTestRequest(`/admin/event/${event.id}?date=2026-03-15`, { cookie });
      const html = await response.text();
      expect(html).toContain("Standard User");
      expect(html).not.toContain("<th>Date</th>");
    });

    test("CSV export includes Date column for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}/export`, { cookie });
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).toContain("Date,Name,Email");
    });

    test("CSV export excludes Date column for standard events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent();
      await createTestAttendee(event.id, event.slug, "CSV User", "csv@test.com");

      const response = await awaitTestRequest(`/admin/event/${event.id}/export`, { cookie });
      const csv = await response.text();
      expect(csv.startsWith("Name,Email")).toBe(true);
    });

    test("CSV export filters by ?date= for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}/export?date=${validDate2}`, { cookie });
      const csv = await response.text();
      expect(csv).toContain("User C");
      expect(csv).not.toContain("User A");
    });

    test("CSV export filename includes date when filtered", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}/export?date=${validDate1}`, { cookie });
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain(validDate1);
      expect(disposition).toContain("_attendees.csv");
    });

    test("Export CSV link includes ?date= when filter is active", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}?date=${validDate1}`, { cookie });
      const html = await response.text();
      expect(html).toContain(`/admin/event/${event.id}/export?date=${validDate1}`);
    });

    test("filter links preserve ?date= query parameter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}?date=${validDate1}`, { cookie });
      const html = await response.text();
      expect(html).toContain(`/admin/event/${event.id}/in?date=${validDate1}#attendees`);
      expect(html).toContain(`/admin/event/${event.id}/out?date=${validDate1}#attendees`);
    });
  });

  describe("stale reservation cleanup on admin event view", () => {
    test("cleans up stale reservations when viewing an event", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({
        name: "Cleanup Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Insert a stale reservation (older than 5 minutes)
      const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      await getDb().execute({
        sql: "INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at) VALUES (?, NULL, ?)",
        args: ["cs_stale_admin_test", staleTime],
      });

      // Verify it exists
      const before = await getDb().execute({
        sql: "SELECT * FROM processed_payments WHERE payment_session_id = ?",
        args: ["cs_stale_admin_test"],
      });
      expect(before.rows.length).toBe(1);

      // View the admin event page
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);

      // Stale reservation should be cleaned up
      const after = await getDb().execute({
        sql: "SELECT * FROM processed_payments WHERE payment_session_id = ?",
        args: ["cs_stale_admin_test"],
      });
      expect(after.rows.length).toBe(0);
    });

    test("does not clean up fresh reservations when viewing an event", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({
        name: "Fresh Reservation Test",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Insert a fresh reservation (just now)
      await getDb().execute({
        sql: "INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at) VALUES (?, NULL, ?)",
        args: ["cs_fresh_admin_test", new Date().toISOString()],
      });

      // View the admin event page
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);

      // Fresh reservation should still exist
      const after = await getDb().execute({
        sql: "SELECT * FROM processed_payments WHERE payment_session_id = ?",
        args: ["cs_fresh_admin_test"],
      });
      expect(after.rows.length).toBe(1);
    });
  });

});
