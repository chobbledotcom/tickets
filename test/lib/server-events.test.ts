import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { addDays } from "#lib/dates.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { getDb } from "#lib/db/client.ts";
import { invalidateEventsCache } from "#lib/db/events.ts";
import { resetDemoMode } from "#lib/demo.ts";
import { nowMs } from "#lib/now.ts";
import { todayInTz } from "#lib/timezone.ts";
import { handleRequest } from "#routes";
import { formatCountdown, withCookie } from "#routes/utils.ts";
import {
  adminGet,
  awaitTestRequest,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  createTestGroup,
  deactivateTestEvent,
  expectAdminRedirect,
  expectHtmlResponse,
  expectRedirect,
  expectStatus,
  loginAsAdmin,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setupEventAndLogin,
  submitTicketForm,
  updateTestEvent,
} from "#test-utils";

describe("server (admin events)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    Deno.env.delete("DEMO_MODE");
    resetDemoMode();
    resetDb();
  });

  describe("GET /admin/event/new", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/event/new"));
      expectAdminRedirect(response);
    });

    test("renders create event form when authenticated", async () => {
      const { response } = await adminGet("/admin/event/new");
      await expectHtmlResponse(
        response,
        200,
        "Add Event",
        'action="/admin/event"',
      );
    });
  });

  describe("POST /admin/event", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockMultipartRequest("/admin/event", {
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
        mockMultipartRequest(
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
      expectRedirect("/admin?success=Event+created")(response);

      // Verify event was actually created
      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event).not.toBeNull();
      expect(event?.name).toBe("New Event");
    });

    test("clears webhook URL when creating event in demo mode", async () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();

      try {
        const { cookie, csrfToken } = await loginAsAdmin();

        const response = await handleRequest(
          mockMultipartRequest(
            "/admin/event",
            {
              name: "Demo Event",
              max_attendees: "50",
              max_quantity: "1",
              webhook_url: "https://example.com/webhook",
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        expectRedirect("/admin?success=Event+created")(response);

        // Verify webhook_url was cleared
        const { getEvent } = await import("#lib/db/events.ts");
        const event = await getEvent(1);
        expect(event).not.toBeNull();
        expect(event?.webhook_url).toBe("");
      } finally {
        Deno.env.delete("DEMO_MODE");
        resetDemoMode();
      }
    });

    test("creates event with group_id when provided", async () => {
      const group = await createTestGroup({
        name: "Event Group",
        slug: "event-group",
      });
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/event",
          {
            name: "Grouped Event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            group_id: String(group.id),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect("/admin?success=Event+created")(response);

      const { getEvent } = await import("#lib/db/events.ts");
      const event = await getEvent(1);
      expect(event?.group_id).toBe(group.id);
    });

    test("rejects non-existent group_id on create", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/event",
          {
            name: "Bad Group Event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
            group_id: "999",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectStatus(400)(response);

      const { getAllEvents } = await import("#lib/db/events.ts");
      const events = await getAllEvents();
      const match = events.find((e) => e.name === "Bad Group Event");
      expect(match).toBeUndefined();
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockMultipartRequest(
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects missing CSRF token", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/event",
          {
            name: "New Event",
            max_attendees: "50",
            max_quantity: "1",
            thank_you_url: "https://example.com/thanks",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("stays on form with error on validation failure", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockMultipartRequest(
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
      await expectHtmlResponse(response, 400, "Add Event");
    });

    test("rejects duplicate slug", async () => {
      // First, create an event with a specific name
      const { cookie, csrfToken } = await setupEventAndLogin({
        name: "Duplicate Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Try to create another event with the same name (generates same slug)
      const response = await handleRequest(
        mockMultipartRequest(
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
      // Slug auto-generated so creation succeeds
      expectRedirect("/admin?success=Event+created")(response);
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
      const { event, cookie } = await setupEventAndLogin({
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1", {
        cookie: cookie,
      });
      await expectHtmlResponse(response, 200, event.name);
    });

    test("shows Edit link on event page", async () => {
      const { cookie } = await setupEventAndLogin({
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
      const { cookie } = await setupEventAndLogin({
        name: "Original Event",
        maxAttendees: 75,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 2000,
        webhookUrl: "https://example.com/webhook",
      });

      const response = await awaitTestRequest("/admin/event/1/duplicate", {
        cookie: cookie,
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Duplicate Event",
        "Original Event",
        'value="75"',
        'value="20.00"',
        'value="https://example.com/thanks"',
        'value="https://example.com/webhook"',
      );
      // Name field should be empty (not pre-filled)
      expect(html).not.toContain('value="Original Event"');
      // Form posts to create endpoint
      expect(html).toContain('action="/admin/event"');
      // Name field has autofocus
      expect(html).toContain("autofocus");
    });

    test("shows Duplicate link on event detail page", async () => {
      const { cookie } = await setupEventAndLogin({
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
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const checkedInAttendee = await createTestAttendee(
        event.id,
        event.slug,
        "Checked In User",
        "in@example.com",
      );
      await createTestAttendee(
        event.id,
        event.slug,
        "Not Checked User",
        "out@example.com",
      );

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
      const html = await expectHtmlResponse(response, 200, "Checked In User");
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
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const checkedInAttendee = await createTestAttendee(
        event.id,
        event.slug,
        "Checked In User",
        "in@example.com",
      );
      await createTestAttendee(
        event.id,
        event.slug,
        "Not Checked User",
        "out@example.com",
      );

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
      const { cookie } = await setupEventAndLogin({
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
      const { event, cookie } = await setupEventAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      await createTestAttendee(
        event.id,
        event.slug,
        "Jane Smith",
        "jane@example.com",
      );

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export`,
        {
          cookie: cookie,
        },
      );
      const csv = await response.text();
      expect(csv).toContain(
        "Name,Email,Phone,Address,Special Instructions,Quantity,Registered",
      );
      expect(csv).toContain("John Doe");
      expect(csv).toContain("john@example.com");
      expect(csv).toContain("Jane Smith");
      expect(csv).toContain("jane@example.com");
    });

    test("returns CSV with Checked In column", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      // Check in the attendee
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export`,
        {
          cookie: cookie,
        },
      );
      const csv = await response.text();
      expect(csv).toContain(",Checked In");
      // John Doe is checked in
      expect(csv).toContain("John Doe");
      expect(csv).toContain(",Yes");
    });

    test("sanitizes slug for filename", async () => {
      const { cookie } = await setupEventAndLogin({
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
      const { event, cookie } = await setupEventAndLogin({
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1500,
      });

      const response = await awaitTestRequest("/admin/event/1/edit", {
        cookie: cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Edit:",
        'value="Test Event"',
        'value="100"',
        'value="15.00"',
        'value="https://example.com/thanks"',
        `value="${event.slug}"`,
        "Slug",
      );
    });
  });

  describe("POST /admin/event/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockMultipartRequest("/admin/event/1/edit", {
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
      const { cookie } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("validates required fields", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event Name is required");
    });

    test("updates event when authenticated", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
            unit_price: "20.00",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1?success=Event+updated")(response);

      // Verify the event was updated
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(1);
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });

    test("clears webhook URL when updating event in demo mode", async () => {
      Deno.env.set("DEMO_MODE", "true");
      resetDemoMode();

      try {
        const { event, cookie, csrfToken } = await setupEventAndLogin({
          maxAttendees: 100,
          webhookUrl: "https://example.com/original-webhook",
        });

        const response = await handleRequest(
          mockFormRequest(
            "/admin/event/1/edit",
            {
              name: event.name,
              slug: event.slug,
              max_attendees: "200",
              max_quantity: "5",
              webhook_url: "https://example.com/new-webhook",
              csrf_token: csrfToken,
            },
            cookie,
          ),
        );
        expectRedirect("/admin/event/1?success=Event+updated")(response);

        // Verify webhook_url was cleared
        const { getEventWithCount } = await import("#lib/db/events.ts");
        const updated = await getEventWithCount(1);
        expect(updated?.webhook_url).toBe("");
      } finally {
        Deno.env.delete("DEMO_MODE");
        resetDemoMode();
      }
    });

    test("updates event group_id", async () => {
      const group1 = await createTestGroup({
        name: "Group One",
        slug: "group-one",
      });
      const group2 = await createTestGroup({
        name: "Group Two",
        slug: "group-two",
      });
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Group Switch Event",
        groupId: group1.id,
        maxAttendees: 50,
      });
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: event.slug,
            group_id: String(group2.id),
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect(`/admin/event/${event.id}?success=Event+updated`)(
        response,
      );

      const { getEvent } = await import("#lib/db/events.ts");
      const updated = await getEvent(event.id);
      expect(updated?.group_id).toBe(group2.id);
    });

    test("rejects non-existent group_id on edit", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Edit Bad Group",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: event.slug,
            group_id: "999",
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 400, "Selected group does not exist");
    });

    test("updates event slug", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      expectRedirect(`/admin/event/${event.id}?success=Event+updated`)(
        response,
      );

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.slug).toBe("new-custom-slug");
    });

    test("normalizes slug on update (spaces, uppercase)", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      expectRedirect(`/admin/event/${event.id}?success=Event+updated`)(
        response,
      );

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.slug).toBe("my-custom-slug");
    });

    test("rejects invalid slug characters", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(
        response,
        400,
        "Slug may only contain lowercase letters, numbers, and hyphens",
      );
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
      await expectHtmlResponse(
        response,
        400,
        "Slug is already in use by another event",
      );
    });

    test("rejects slug used by a group", async () => {
      const group = await createTestGroup({
        name: "Slug Group",
        slug: "slug-group",
      });
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Event Slug Collision",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: group.slug,
            max_attendees: "50",
            max_quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Slug is already in use by another event",
      );
    });

    test("allows keeping the same slug on update", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      expectRedirect(`/admin/event/${event.id}?success=Event+updated`)(
        response,
      );

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
      const { event, cookie } = await setupEventAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/deactivate", {
        cookie: cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Deactivate Event",
        "Return a 404",
        'name="confirm_identifier"',
        "type its name",
        event.name,
      );
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
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      expectRedirect("/admin/event/1?success=Event+deactivated")(response);

      // Verify event is now inactive
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const deactivatedEvent = await getEventWithCount(1);
      expect(deactivatedEvent?.active).toBe(false);
    });

    test("returns error when identifier does not match", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event name does not match");
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
      const { event, cookie } = await setupEventAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the event first
      await deactivateTestEvent(event.id);

      const response = await awaitTestRequest("/admin/event/1/reactivate", {
        cookie: cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Reactivate Event",
        "available for registrations",
        'name="confirm_identifier"',
        "type its name",
      );
    });
  });

  describe("POST /admin/event/:id/reactivate", () => {
    test("reactivates event and redirects", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      expectRedirect("/admin/event/1?success=Event+reactivated")(response);

      // Verify event is now active
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const activeEvent = await getEventWithCount(1);
      expect(activeEvent?.active).toBe(true);
    });

    test("returns error when name does not match", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event name does not match");
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
      const { event, cookie } = await setupEventAndLogin({
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/event/1/delete", {
        cookie: cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Delete Event",
        event.name,
        "type its name",
      );
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
      const { event, cookie } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched event identifier", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "does not match");
    });

    test("deletes event with matching identifier (case insensitive)", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
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
      expectRedirect("/admin?success=Event+deleted")(response);

      // Verify event was deleted
      const { getEvent } = await import("#lib/db/events.ts");
      const deletedEvent = await getEvent(1);
      expect(deletedEvent).toBeNull();
    });

    test("deletes event with matching identifier (trimmed)", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
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
      expectRedirect("/admin?success=Event+deleted")(response);
    });

    test("deletes event and all attendees", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      await createTestAttendee(
        event.id,
        event.slug,
        "Jane Doe",
        "jane@example.com",
      );

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

    test("returns 404 when event not found with verify_identifier=false", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/9999/delete?verify_identifier=false",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
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
        new Request(
          "http://localhost/admin/event/1/delete?verify_identifier=false",
          {
            method: "DELETE",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: cookie,
              host: "localhost",
            },
            body: new URLSearchParams({
              csrf_token: csrfToken,
            }).toString(),
          },
        ),
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
            unit_price: "10.00",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("POST /admin/event with can_pay_more", () => {
    test("creates event with can_pay_more enabled", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        await mockMultipartRequest(
          "/admin/event",
          {
            name: "Pay More Event",
            max_attendees: "50",
            max_quantity: "1",
            unit_price: "10.00",
            can_pay_more: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const event = await getEventWithCount(1);
      expect(event?.can_pay_more).toBe(true);
      expect(event?.unit_price).toBe(1000);
    });

    test("creates event with can_pay_more disabled by default", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        await mockMultipartRequest(
          "/admin/event",
          {
            name: "Normal Event",
            max_attendees: "50",
            max_quantity: "1",
            unit_price: "5.00",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const event = await getEventWithCount(1);
      expect(event?.can_pay_more).toBe(false);
    });

    test("updates event can_pay_more via edit", async () => {
      const event = await createTestEvent({ unitPrice: 1000 });
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        await mockMultipartRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: event.slug,
            max_attendees: String(event.max_attendees),
            max_quantity: String(event.max_quantity),
            unit_price: "10.00",
            can_pay_more: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.can_pay_more).toBe(true);
    });
  });

  describe("POST /admin/event with max_price", () => {
    test("creates event with max_price", async () => {
      const event = await createTestEvent({
        canPayMore: true,
        maxPrice: 50000,
      });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.max_price).toBe(50000);
      expect(saved?.can_pay_more).toBe(true);
    });

    test("max_price defaults to 10000 when not set", async () => {
      const event = await createTestEvent({ canPayMore: true });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.max_price).toBe(10000);
    });

    test("rejects max_price less than unit_price + 100 when can_pay_more", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/event",
          {
            name: "Bad Max Price",
            max_attendees: "50",
            max_quantity: "1",
            unit_price: "10.00",
            max_price: "10.50",
            can_pay_more: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Maximum price must be at least £1 more than the ticket price",
      );
    });

    test("allows max_price less than unit_price + 100 when can_pay_more is off", async () => {
      const event = await createTestEvent({ unitPrice: 1000, maxPrice: 1050 });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.max_price).toBe(1050);
    });

    test("accepts max_price equal to unit_price + 100", async () => {
      const event = await createTestEvent({ unitPrice: 1000, maxPrice: 1100 });
      expect(event.max_price).toBe(1100);
    });

    test("updates max_price via edit", async () => {
      const event = await createTestEvent({
        canPayMore: true,
        unitPrice: 1000,
      });
      await updateTestEvent(event.id, { maxPrice: 25000 });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.max_price).toBe(25000);
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
      await expectHtmlResponse(response, 200, "Log");
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
      const response = await handleRequest(mockRequest("/admin/event/1/log"));
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
      const { event, cookie } = await setupEventAndLogin({
        name: "Event Log",
        maxAttendees: 50,
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}/log`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, "Log", event.name);
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
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "On Delete Test",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "Test User",
        "test@example.com",
      );

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
      const { cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event Name is required");
    });
  });

  describe("admin/events.ts (form.get fallbacks)", () => {
    test("deactivate event without confirm_identifier uses empty fallback", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event name does not match");
    });

    test("reactivate event without confirm_identifier uses empty fallback", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event name does not match");
    });

    test("delete event without confirm_identifier uses empty fallback", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
        name: "Delete Fallback",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Submit without confirm_identifier field
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/delete",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 400, "does not match");
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
      const {
        event: event1,
        cookie,
        csrfToken,
      } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event Name is required");
    });
  });

  describe("POST /admin/event/:id/delete with custom onDelete", () => {
    test("deletes event and cascades to attendees", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Cascade Delete",
        maxAttendees: 50,
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "Test User",
        "test@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect("/admin?success=Event+deleted")(response);

      const { getEvent: getEventFn } = await import("#lib/db/events.ts");
      const deleted = await getEventFn(event.id);
      expect(deleted).toBeNull();
    });
  });

  describe("routes/admin/events.ts (event error page)", () => {
    test("shows edit error page for existing event with validation error", async () => {
      const {
        event: event1,
        cookie,
        csrfToken,
      } = await setupEventAndLogin({
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
      await expectHtmlResponse(response, 400, "Event Name is required");
    });

    test("event delete cascades to attendees using custom onDelete", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Cascade Del Test",
        maxAttendees: 50,
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "Del User",
        "del@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/delete?verify_identifier=false`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expectRedirect("/admin?success=Event+deleted")(response);

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
      const findByIdStub = stub(
        eventsTable,
        "findById",
        async (id: unknown) => {
          const row = await originalFindById(id as number);
          if (row) {
            // Delete the event from DB so getEventWithCount returns null
            const { getDb } = await import("#lib/db/client.ts");
            await getDb().execute({
              sql: "DELETE FROM events WHERE id = ?",
              args: [id as number],
            });
            invalidateEventsCache();
          }
          return row;
        },
      );

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
        findByIdStub.restore();
      }
    });
  });

  describe("admin event onDelete handler", () => {
    test("deleting an event triggers the onDelete handler which calls deleteEvent", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Delete OnDelete Test",
        maxAttendees: 10,
      });
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
      const executeStub = stub(db, "execute", async (query: unknown) => {
        const sql =
          typeof query === "string" ? query : (query as { sql: string }).sql;
        // Intercept the isSlugTaken query
        if (
          sql.includes("SELECT 1 WHERE EXISTS") &&
          sql.includes("FROM events WHERE slug_index")
        ) {
          return {
            rows: [{ "1": 1 }],
            columns: ["1"],
            rowsAffected: 0,
            lastInsertRowid: 0n,
          } as unknown as Awaited<ReturnType<typeof originalExecute>>;
        }
        return await originalExecute(
          query as Parameters<typeof originalExecute>[0],
        );
      });

      try {
        const response = await handleRequest(
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
        );
        await expectHtmlResponse(response, 503, "Temporary Error");
      } finally {
        executeStub.restore();
      }
    });
  });

  describe("edit event notFound race condition", () => {
    test("returns 404 when event is deleted during edit update", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Race Condition Event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // handleAdminEventEditPost calls getEventWithCount (raw SQL), then
      // updateResource.update which calls requireExists -> table.findById.
      // We spy on findById to return null, simulating the event being deleted
      // between the initial check and the update.
      const { eventsTable: table } = await import("#lib/db/events.ts");
      const findByIdStub2 = stub(table, "findById", () =>
        Promise.resolve(null),
      );

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
        findByIdStub2.restore();
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
      const { event, cookie } = await setupEventAndLogin({
        closesAt: "2099-06-15T14:30",
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Registration Closes",
      );
      expect(html).not.toContain("No deadline");
      expect(html).toContain("from now");
    });

    test("admin event detail page shows 'No deadline' when closes_at is null", async () => {
      const { event, cookie } = await setupEventAndLogin();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, "No deadline");
    });

    test("admin event edit page shows closes_at in form", async () => {
      const { event, cookie } = await setupEventAndLogin({
        closesAt: "2099-06-15T14:30",
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        'value="2099-06-15"',
        'value="14:30"',
        "Registration Closes At",
      );
    });

    test("admin event detail page shows 'closed' countdown for past closes_at", async () => {
      const { event, cookie } = await setupEventAndLogin({
        closesAt: "2024-01-01T00:00",
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, "(closed)");
    });

    test("admin event detail page shows days-only countdown", async () => {
      const { cookie } = await loginAsAdmin();
      const future = new Date(
        Date.now() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000,
      );
      const closesAt = future.toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, "days from now");
    });

    test("admin event detail page shows hours-only countdown", async () => {
      const { cookie } = await loginAsAdmin();
      const future = new Date(Date.now() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000);
      const closesAt = future.toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, "hours from now");
    });

    test("admin event detail page shows minutes-only countdown", async () => {
      const { cookie } = await loginAsAdmin();
      const future = new Date(Date.now() + 30 * 60 * 1000);
      const closesAt = future.toISOString().slice(0, 16);
      const event = await createTestEvent({ closesAt });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, "minute");
    });

    test("formatCountdown shows days and hours", () => {
      const future = new Date(
        nowMs() + 3 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000 + 30 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("3 days and 5 hours from now");
    });

    test("formatCountdown shows only days when no remaining hours", () => {
      const future = new Date(
        nowMs() + 2 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("2 days from now");
    });

    test("formatCountdown shows only hours", () => {
      const future = new Date(
        nowMs() + 5 * 60 * 60 * 1000 + 10 * 60 * 1000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("5 hours from now");
    });

    test("formatCountdown shows minutes when less than an hour", () => {
      const result = formatCountdown(
        new Date(nowMs() + 30 * 60 * 1000).toISOString(),
      );
      expect(result).toContain("minute");
      expect(result).toContain("from now");
    });

    test("formatCountdown shows closed for past dates", () => {
      expect(formatCountdown("2024-01-01T00:00:00.000Z")).toBe("closed");
    });

    test("formatCountdown singular forms", () => {
      // Add 30s buffer so elapsed time between nowMs() calls doesn't push hours below boundary
      const future = new Date(
        nowMs() + 1 * 24 * 60 * 60 * 1000 + 1 * 60 * 60 * 1000 + 30_000,
      ).toISOString();
      expect(formatCountdown(future)).toBe("1 day and 1 hour from now");
    });

    test("rejects invalid closes_at format", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: event.slug,
            max_attendees: "100",
            max_quantity: "1",
            closes_at_date: "not-a-date",
            closes_at_time: "99:99",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Please enter a valid date and time",
      );
    });
  });

  describe("event date and location", () => {
    test("creates event with date and location", async () => {
      const event = await createTestEvent({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.date).toBe("2026-06-15T14:00:00.000Z");
      expect(saved?.location).toBe("Village Hall");
    });

    test("updates event date and location", async () => {
      const event = await createTestEvent();
      await updateTestEvent(event.id, {
        date: "2026-12-25T18:00",
        location: "Town Centre",
      });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.date).toBe("2026-12-25T18:00:00.000Z");
      expect(updated?.location).toBe("Town Centre");
    });

    test("clears event date by setting to empty string", async () => {
      const event = await createTestEvent({ date: "2026-06-15T14:00" });
      await updateTestEvent(event.id, { date: "" });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.date).toBe("");
    });

    test("admin detail page shows Event Date and Location when set", async () => {
      const { event, cookie } = await setupEventAndLogin({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Event Date",
        "Monday 15 June 2026 at 14:00 UTC",
        "<th>Location</th>",
        "Village Hall",
      );
    });

    test("admin detail page hides Event Date and Location when empty", async () => {
      const { event, cookie } = await setupEventAndLogin();
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Event Date");
      expect(html).not.toContain("<th>Location</th>");
    });

    test("admin edit page pre-fills date as split inputs", async () => {
      const { event, cookie } = await setupEventAndLogin({
        date: "2026-06-15T14:00",
      });
      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        'value="2026-06-15"',
        'value="14:00"',
      );
    });

    test("admin edit page pre-fills location", async () => {
      const { event, cookie } = await setupEventAndLogin({
        location: "Village Hall",
      });
      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, 'value="Village Hall"');
    });

    test("CSV export includes Event Date and Event Location columns", async () => {
      const { event, cookie } = await setupEventAndLogin({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      await createTestAttendee(event.id, event.slug, "Alice", "alice@test.com");
      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export`,
        { cookie },
      );
      await expectHtmlResponse(
        response,
        200,
        "Event Date",
        "Event Location",
        "Village Hall",
      );
    });

    test("CSV export omits Event Date and Event Location when empty", async () => {
      const { event, cookie } = await setupEventAndLogin();
      await createTestAttendee(event.id, event.slug, "Bob", "bob@test.com");
      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).not.toContain("Event Date");
      expect(csv).not.toContain("Event Location");
    });

    test("rejects invalid event date on edit", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: event.slug,
            max_attendees: "100",
            max_quantity: "1",
            date_date: "not-a-date",
            date_time: "99:99",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        "Please enter a valid date and time",
      );
    });
  });

  describe("withCookie", () => {
    test("adds a cookie to a response without existing cookies", async () => {
      const response = new Response("body", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });

    test("preserves existing set-cookie headers when adding another", async () => {
      const headers = new Headers();
      headers.append("set-cookie", "first=one; Path=/");
      const response = new Response("body", { status: 200, headers });
      const result = await withCookie(response, "second=two; Path=/");
      const cookies = result.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      expect(cookies).toContain("first=one; Path=/");
      expect(cookies).toContain("second=two; Path=/");
    });

    test("preserves response status", async () => {
      const response = new Response("body", { status: 201 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(201);
    });

    test("preserves text response body", async () => {
      const response = new Response("hello world", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(await result.text()).toBe("hello world");
    });

    test("preserves binary response body", async () => {
      const bytes = new Uint8Array([0, 1, 2, 128, 255]);
      const response = new Response(bytes, { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      const body = new Uint8Array(await result.arrayBuffer());
      expect(body.length).toBe(5);
      expect(body[0]).toBe(0);
      expect(body[3]).toBe(128);
      expect(body[4]).toBe(255);
    });

    test("handles null body response", async () => {
      const response = new Response(null, { status: 204 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(204);
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });
  });

  describe("daily event type", () => {
    test("creates a daily event with custom config", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: ["Monday", "Wednesday", "Friday"],
        minimumDaysBefore: 2,
        maximumDaysAfter: 30,
      });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.event_type).toBe("daily");
      expect(saved?.bookable_days).toEqual(["Monday", "Wednesday", "Friday"]);
      expect(saved?.minimum_days_before).toBe(2);
      expect(saved?.maximum_days_after).toBe(30);
    });

    test("creates standard event with default daily config", async () => {
      const event = await createTestEvent();

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.event_type).toBe("standard");
      expect(saved?.bookable_days).toEqual([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ]);
      expect(saved?.minimum_days_before).toBe(1);
      expect(saved?.maximum_days_after).toBe(90);
    });

    test("admin event detail page shows Daily type for daily events", async () => {
      const { event, cookie } = await setupEventAndLogin({
        eventType: "daily",
        bookableDays: ["Monday", "Tuesday"],
        minimumDaysBefore: 3,
        maximumDaysAfter: 60,
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Event Type",
        "Daily",
        "Bookable Days",
        "Monday,Tuesday",
        "Booking Window",
        "3 to 60 days",
        "Capacity of",
        "applies per date",
      );
    });

    test("admin event detail page shows Standard type without daily config", async () => {
      const { event, cookie } = await setupEventAndLogin();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Event Type",
        "Standard",
      );
      expect(html).not.toContain("Bookable Days");
      expect(html).not.toContain("Booking Window");
    });

    test("admin event edit page pre-fills daily config", async () => {
      const { event, cookie } = await setupEventAndLogin({
        eventType: "daily",
        bookableDays: ["Wednesday", "Friday"],
        minimumDaysBefore: 5,
        maximumDaysAfter: 120,
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      const html = await expectHtmlResponse(
        response,
        200,
        'value="Wednesday" checked',
        'value="Friday" checked',
      );
      expect(html).not.toContain('value="Monday" checked');
      expect(html).toContain('value="5"');
      expect(html).toContain('value="120"');
    });

    test("updates event from standard to daily", async () => {
      const event = await createTestEvent();
      await updateTestEvent(event.id, {
        eventType: "daily",
        bookableDays: ["Saturday", "Sunday"],
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.event_type).toBe("daily");
      expect(updated?.bookable_days).toEqual(["Saturday", "Sunday"]);
      expect(updated?.minimum_days_before).toBe(0);
      expect(updated?.maximum_days_after).toBe(14);
    });

    test("updates event from daily to standard", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: ["Monday"],
        minimumDaysBefore: 7,
        maximumDaysAfter: 365,
      });
      await updateTestEvent(event.id, { eventType: "standard" });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.event_type).toBe("standard");
    });

    test("duplicate page pre-fills daily event config", async () => {
      const { cookie } = await setupEventAndLogin({
        eventType: "daily",
        bookableDays: ["Tuesday", "Thursday"],
        minimumDaysBefore: 2,
        maximumDaysAfter: 45,
      });

      const response = await awaitTestRequest("/admin/event/1/duplicate", {
        cookie,
      });
      const html = await expectHtmlResponse(
        response,
        200,
        'value="Tuesday" checked',
        'value="Thursday" checked',
      );
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
      expectStatus(400)(response);
    });

    test("creates event with non_transferable flag", async () => {
      const event = await createTestEvent({ nonTransferable: true });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.non_transferable).toBe(true);
    });

    test("creates event without non_transferable by default", async () => {
      const event = await createTestEvent();

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.non_transferable).toBe(false);
    });

    test("admin event detail page shows non-transferable row when enabled", async () => {
      const { event, cookie } = await setupEventAndLogin({
        nonTransferable: true,
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Non-Transferable",
        "ID verification required at entry",
      );
    });

    test("admin event detail page does not show non-transferable row when disabled", async () => {
      const { event, cookie } = await setupEventAndLogin();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("Non-Transferable");
    });

    test("admin event edit page pre-fills non-transferable select", async () => {
      const { event, cookie } = await setupEventAndLogin({
        nonTransferable: true,
      });

      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Non-Transferable Tickets",
      );
      expect(html).toContain('value="1" selected');
    });

    test("updates event to enable non_transferable", async () => {
      const event = await createTestEvent();
      await updateTestEvent(event.id, { nonTransferable: true });

      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.non_transferable).toBe(true);
    });

    test("rejects invalid bookable_days value", async () => {
      const { cookie, csrfToken } = await setupEventAndLogin({
        name: "Edit Target",
      });

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
      await expectHtmlResponse(response, 400, "Invalid day");
    });
  });

  describe("audit logging (event edit)", () => {
    test("logs activity when event is updated", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/edit`,
          {
            name: event.name,
            slug: event.slug,
            max_attendees: "200",
            max_quantity: "1",
            thank_you_url: "https://example.com/updated",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      const { getEventActivityLog } = await import("#lib/db/activityLog.ts");
      const logs = await getEventActivityLog(event.id);
      const updateLog = logs.find((l: { message: string }) =>
        l.message.includes("updated"),
      );
      expect(updateLog).toBeDefined();
      expect(updateLog?.message).toContain(event.name);
    });
  });

  describe("daily event admin view (Phase 4)", () => {
    const validDate1 = addDays(todayInTz("UTC"), 1);
    const validDate2 = addDays(todayInTz("UTC"), 2);

    const createDailyEventWithAttendees = async () => {
      const event = await createTestEvent({
        eventType: "daily",
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });
      // Create attendees on two different dates via the public form
      await submitTicketForm(event.slug, {
        name: "User A",
        email: "a@test.com",
        date: validDate1,
      });
      await submitTicketForm(event.slug, {
        name: "User B",
        email: "b@test.com",
        date: validDate1,
      });
      await submitTicketForm(event.slug, {
        name: "User C",
        email: "c@test.com",
        date: validDate2,
      });
      return event;
    };

    test("shows date selector dropdown for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "<select",
        "All dates",
        validDate1,
        validDate2,
      );
    });

    test("shows Date column header for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("<th>Date</th>");
    });

    test("does not show Date column for standard events", async () => {
      const { event, cookie } = await setupEventAndLogin();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("<th>Date</th>");
    });

    test("filters attendees by ?date= parameter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      // Filter to date1 — should show 2 attendees (User A and User B)
      const response = await awaitTestRequest(
        `/admin/event/${event.id}?date=${validDate1}`,
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).toContain("User B");
      expect(html).not.toContain("User C");
    });

    test("filters attendees by ?date= showing other date", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      // Filter to date2 — should show 1 attendee (User C)
      const response = await awaitTestRequest(
        `/admin/event/${event.id}?date=${validDate2}`,
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain("User C");
      expect(html).not.toContain("User A");
    });

    test("shows per-date capacity when date filter is active", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?date=${validDate1}`,
        { cookie },
      );
      const html = await response.text();
      // Should show "2 / 100" for the 2 attendees on date1
      expect(html).toContain("2 / 100");
      expect(html).toContain("98 remain");
    });

    test("shows total count without date filter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("(total)");
      expect(html).toContain("Capacity of");
    });

    test("date filter composes with check-in filter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      // Filter to date1 + checked out — should show both since none are checked in
      const response = await awaitTestRequest(
        `/admin/event/${event.id}/out?date=${validDate1}`,
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain("User A");
      expect(html).toContain("User B");
      expect(html).not.toContain("User C");
    });

    test("ignores ?date= for standard events", async () => {
      const { event, cookie } = await setupEventAndLogin();
      await createTestAttendee(
        event.id,
        event.slug,
        "Standard User",
        "std@test.com",
      );

      // Even with ?date= param, standard events show all attendees
      const response = await awaitTestRequest(
        `/admin/event/${event.id}?date=2026-03-15`,
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain("Standard User");
      expect(html).not.toContain("<th>Date</th>");
    });

    test("CSV export includes Date column for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export`,
        { cookie },
      );
      await expectHtmlResponse(response, 200, "Date,Name,Email");
    });

    test("CSV export excludes Date column for standard events", async () => {
      const { event, cookie } = await setupEventAndLogin();
      await createTestAttendee(
        event.id,
        event.slug,
        "CSV User",
        "csv@test.com",
      );

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export`,
        { cookie },
      );
      const csv = await response.text();
      expect(csv.startsWith("Name,Email")).toBe(true);
    });

    test("CSV export filters by ?date= for daily events", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export?date=${validDate2}`,
        { cookie },
      );
      const csv = await response.text();
      expect(csv).toContain("User C");
      expect(csv).not.toContain("User A");
    });

    test("CSV export filename includes date when filtered", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/export?date=${validDate1}`,
        { cookie },
      );
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain(validDate1);
      expect(disposition).toContain("_attendees.csv");
    });

    test("Export CSV link includes ?date= when filter is active", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?date=${validDate1}`,
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain(
        `/admin/event/${event.id}/export?date=${validDate1}`,
      );
    });

    test("filter links preserve ?date= query parameter", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createDailyEventWithAttendees();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?date=${validDate1}`,
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain(
        `/admin/event/${event.id}/in?date=${validDate1}#attendees`,
      );
      expect(html).toContain(
        `/admin/event/${event.id}/out?date=${validDate1}#attendees`,
      );
    });
  });

  describe("stale reservation cleanup on admin event view", () => {
    test("cleans up stale reservations when viewing an event", async () => {
      const { event, cookie } = await setupEventAndLogin({
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
      const { event, cookie } = await setupEventAndLogin({
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

  describe("hidden events", () => {
    test("creates event with hidden enabled", async () => {
      const event = await createTestEvent({ hidden: true });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.hidden).toBe(true);
    });

    test("creates event with hidden disabled by default", async () => {
      const event = await createTestEvent();
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const saved = await getEventWithCount(event.id);
      expect(saved?.hidden).toBe(false);
    });

    test("updates event to enable hidden", async () => {
      const event = await createTestEvent();
      await updateTestEvent(event.id, { hidden: true });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.hidden).toBe(true);
    });

    test("updates event to enable can_pay_more via updateTestEvent", async () => {
      const event = await createTestEvent({ unitPrice: 1000 });
      await updateTestEvent(event.id, { canPayMore: true });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.can_pay_more).toBe(true);
    });

    test("updates event to disable hidden", async () => {
      const event = await createTestEvent({ hidden: true });
      await updateTestEvent(event.id, { hidden: false });
      const { getEventWithCount } = await import("#lib/db/events.ts");
      const updated = await getEventWithCount(event.id);
      expect(updated?.hidden).toBe(false);
    });

    test("admin event detail page shows Hidden row when enabled", async () => {
      const { event, cookie } = await setupEventAndLogin({
        hidden: true,
      });
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Hidden",
        "not shown in public events list",
      );
    });

    test("admin event detail page does not show Hidden row when disabled", async () => {
      const { event, cookie } = await setupEventAndLogin();
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("not shown in public events list");
    });

    test("admin event edit page pre-fills hidden checkbox", async () => {
      const { event, cookie } = await setupEventAndLogin({
        hidden: true,
      });
      const response = await awaitTestRequest(`/admin/event/${event.id}/edit`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("hidden");
    });
  });
});
