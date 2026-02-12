import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { attendeesApi } from "#lib/db/attendees.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  getAttendeesRaw,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  expectRedirect,
  loginAsAdmin,
  withMocks,
} from "#test-utils";

describe("server (admin attendees)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/attendee/${attendee.id}/delete`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/999/attendee/1/delete",
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/999/delete",
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 when attendee belongs to different event", async () => {
      const event1 = await createTestEvent({
        name: "Event 1",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        name: "Event 2",
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event2.id, event2.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      // Try to delete attendee from event 2 via event 1 URL
      const response = await awaitTestRequest(
        `/admin/event/${event1.id}/attendee/${attendee.id}/delete`,
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
        { cookie: cookie },
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
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee/${attendee.id}/delete`, {
          confirm_name: "John Doe",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/delete",
          {
            confirm_name: "John Doe",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/delete",
          {
            confirm_name: "John Doe",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

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
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "Wrong Name",
            csrf_token: csrfToken,
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
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "john doe", // lowercase
            csrf_token: csrfToken,
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
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "  John Doe  ", // with spaces
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expectRedirect("/admin/event/1")(response);
    });
  });

  describe("DELETE /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("deletes attendee with DELETE method", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const formBody = new URLSearchParams({
        confirm_name: "John Doe",
        csrf_token: csrfToken,
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
      expectRedirect("/admin/event/1")(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deletedAttendee = await getAttendeeRaw(1);
      expect(deletedAttendee).toBeNull();
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/delete (confirm_name edge case)", () => {
    test("handles missing confirm_name field (falls back to empty string)", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      // Submit without confirm_name field at all
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      // Empty string won't match "John Doe", so it returns 400
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("returns 404 for non-existent attendee on delete page", async () => {
      const { cookie } = await loginAsAdmin();
      const event = await createTestEvent({
        name: "Att Del 404",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        new Request(`http://localhost/admin/event/${event.id}/attendee/99999/delete`, {
          headers: {
            host: "localhost",
            cookie,
          },
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("exercises parseAttendeeIds via POST route with valid params", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const event = await createTestEvent({
        name: "Parse Ids Test",
        maxAttendees: 50,
      });
      const attendee = await createTestAttendee(event.id, event.slug, "Test User", "test@example.com");

      // POST route exercises attendeeDeleteHandler which calls parseAttendeeIds.
      // The custom handler requires confirm_name to match the attendee name.
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { csrf_token: csrfToken, confirm_name: "Test User" },
          cookie,
        ),
      );
      // Should redirect after successful delete
      expect(response.status).toBe(302);
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/checkin", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee/${attendee.id}/checkin`, {}),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: "invalid-token" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/checkin",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/checkin",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("checks in an attendee and redirects with message", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}`);
      expect(location).toContain("checkin_status=in");
      expect(location).toContain("checkin_name=John");
      expect(location).toContain("#message");
    });

    test("redirects to filtered page when return_filter is set", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken, return_filter: "in" },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}/in?`);
      expect(location).toContain("checkin_status=in");
    });

    test("redirects to out filtered page when return_filter is out", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      // Check in first
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      // Check out with return_filter=out
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken, return_filter: "out" },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}/out?`);
      expect(location).toContain("checkin_status=out");
    });

    test("redirects to unfiltered page when return_filter is all", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken, return_filter: "all" },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}?`);
      expect(location).not.toContain("/in?");
      expect(location).not.toContain("/out?");
    });

    test("checks out an already checked-in attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "Jane Doe", "jane@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      // First check in
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      // Then check out
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("checkin_status=out");
    });

    test("event page shows Check in button for unchecked attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Check in");
      expect(html).toContain("/checkin");
    });

    test("event page shows check-in success message when query params present", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?checkin_name=John%20Doe&checkin_status=in`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Checked John Doe in");
      expect(html).toContain('checkin-message-in');
    });

    test("event page shows check-out message in red", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?checkin_name=John%20Doe&checkin_status=out`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Checked John Doe out");
      expect(html).toContain('checkin-message-out');
    });

    test("event page ignores invalid checkin_status param", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?checkin_name=John%20Doe&checkin_status=invalid`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Checked John Doe");
    });

    test("event page shows Check out button for checked-in attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      // Check in first
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      // View event page
      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Check out");
    });
  });

  describe("POST /admin/event/:eventId/attendee (add attendee)", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee`, {
          name: "Jane Doe",
          email: "jane@example.com",
          quantity: "1",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "Jane Doe",
            email: "jane@example.com",
            quantity: "1",
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee",
          {
            name: "Jane Doe",
            email: "jane@example.com",
            quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("adds attendee to email event", async () => {
      const event = await createTestEvent({ maxAttendees: 100, fields: "email" });
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "Jane Doe",
            email: "jane@example.com",
            quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}`);
      expect(location).toContain("added=Jane");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });

    test("adds attendee to phone event", async () => {
      const event = await createTestEvent({ maxAttendees: 100, fields: "phone" });
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "Phone User",
            phone: "+1234567890",
            quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("added=Phone");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });

    test("adds attendee to both event", async () => {
      const event = await createTestEvent({ maxAttendees: 100, fields: "email,phone" });
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "Both User",
            email: "both@example.com",
            phone: "+1234567890",
            quantity: "2",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("added=Both");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.quantity).toBe(2);
    });

    test("redirects with error on validation failure", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "",
            email: "",
            quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("add_error=");
      expect(location).toContain("#add-attendee");
    });

    test("redirects with error when capacity exceeded", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendee(event.id, event.slug, "First", "first@example.com");

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "Second",
            email: "second@example.com",
            quantity: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("add_error=");
      expect(location).toContain("spots");
    });

    test("redirects with error on encryption failure", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { cookie, csrfToken } = await loginAsAdmin();

      await withMocks(
        () => spyOn(attendeesApi, "createAttendeeAtomic").mockResolvedValue({
          success: false,
          reason: "encryption_error",
        }),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              `/admin/event/${event.id}/attendee`,
              {
                name: "Enc Fail",
                email: "enc@example.com",
                quantity: "1",
                csrf_token: csrfToken,
              },
              cookie,
            ),
          );
          expect(response.status).toBe(302);
          const location = response.headers.get("location")!;
          expect(location).toContain("add_error=");
          expect(location).toContain("Encryption");
        },
      );
    });

    test("adds attendee to daily event with date", async () => {
      const { addDays } = await import("#lib/dates.ts");
      const { todayInTz } = await import("#lib/timezone.ts");
      const futureDate = addDays(todayInTz("UTC"), 7);

      const event = await createTestEvent({
        maxAttendees: 100,
        eventType: "daily",
        bookableDays: '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]',
      });
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "Daily User",
            email: "daily@example.com",
            quantity: "1",
            date: futureDate,
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("added=Daily");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.date).toBe(futureDate);
    });

    test("event page shows add attendee form", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Add Attendee");
      expect(html).toContain(`/admin/event/${event.id}/attendee`);
      expect(html).toContain("Your Name");
      expect(html).toContain("Quantity");
    });

    test("event page shows success message when ?added param present", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?added=Jane%20Doe`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Added Jane Doe");
    });

    test("event page shows error message when ?add_error param present", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?add_error=Not%20enough%20spots`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Not enough spots");
    });
  });

});
