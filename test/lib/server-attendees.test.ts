import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import { attendeesApi } from "#lib/db/attendees.ts";
import { handleRequest } from "#routes";
import {
  adminAttendeeAction,
  adminEventPage,
  awaitTestRequest,
  createPaidTestAttendee,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  getAttendeesRaw,
  loginAsAdmin,
  mockFormRequest,
  mockProviderType,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  expectRedirect,
  withMocks,
} from "#test-utils";
import { paymentsApi } from "#lib/payments.ts";

describe("server (admin attendees)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  const deleteAction = adminAttendeeAction("delete");
  const checkinAction = adminAttendeeAction("checkin");

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
      const { response } = await adminEventPage(
        ctx => `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/delete`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Delete Attendee");
      expect(html).toContain("John Doe");
      expect(html).toContain("type their name");
    });

    test("includes return_url as hidden field when provided", async () => {
      const { response } = await adminEventPage(
        ctx => `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/delete?return_url=${encodeURIComponent("/admin/calendar#attendees")}`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="return_url"');
      expect(html).toContain("/admin/calendar#attendees");
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
      const { response } = await deleteAction({ confirm_name: "John Doe", csrf_token: "invalid-token" })();
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await deleteAction({ confirm_name: "Wrong Name" })();
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("preserves return_url on mismatched attendee name", async () => {
      const returnUrl = "/admin/calendar#attendees";
      const { response } = await deleteAction({
        confirm_name: "Wrong Name",
        return_url: returnUrl,
      })();
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('name="return_url"');
      expect(html).toContain(returnUrl);
    });

    test("deletes attendee with matching name (case insensitive)", async () => {
      const { response, event, attendee } = await deleteAction({ confirm_name: "john doe" })();
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("deletes attendee with whitespace-trimmed name", async () => {
      const { response } = await deleteAction({ confirm_name: "  John Doe  " })();
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
      // Submit without confirm_name field at all
      const { response } = await deleteAction({})();
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
      const { response } = await checkinAction({ csrf_token: "invalid-token" })();
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
      const { response, event } = await checkinAction({})();
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}`);
      expect(location).toContain("checkin_status=in");
      expect(location).toContain("checkin_name=John");
      expect(location).toContain("#message");
    });

    test("redirects to filtered page when return_filter is set", async () => {
      const { response, event } = await checkinAction({ return_filter: "in" })();
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}/in?`);
      expect(location).toContain("checkin_status=in");
    });

    test("redirects to out filtered page when return_filter is out", async () => {
      // Check in first, then check out with return_filter=out
      const { event, attendee, cookie, csrfToken } = await checkinAction({})();

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
      const { response, event } = await checkinAction({ return_filter: "all" })();
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}?`);
      expect(location).not.toContain("/in?");
      expect(location).not.toContain("/out?");
    });

    test("redirects to return_url when provided", async () => {
      const { response } = await checkinAction({ return_url: "/admin/calendar?date=2026-03-15#attendees" })();
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/calendar?date=2026-03-15#attendees");
    });

    test("checks out an already checked-in attendee", async () => {
      // First check in via the curried helper
      const { event, attendee, cookie, csrfToken } = await checkinAction({})();

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
      const { response } = await adminEventPage(ctx => `/admin/event/${ctx.event.id}`)();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Check in");
      expect(html).toContain("/checkin");
    });

    test("event page shows check-in success message when query params present", async () => {
      const { response } = await adminEventPage(
        ctx => `/admin/event/${ctx.event.id}?checkin_name=John%20Doe&checkin_status=in`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Checked John Doe in");
      expect(html).toContain('checkin-message-in');
    });

    test("event page shows check-out message in red", async () => {
      const { response } = await adminEventPage(
        ctx => `/admin/event/${ctx.event.id}?checkin_name=John%20Doe&checkin_status=out`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Checked John Doe out");
      expect(html).toContain('checkin-message-out');
    });

    test("event page ignores invalid checkin_status param", async () => {
      const { response } = await adminEventPage(
        ctx => `/admin/event/${ctx.event.id}?checkin_name=John%20Doe&checkin_status=invalid`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Checked John Doe");
    });

    test("event page shows Check out button for checked-in attendee", async () => {
      // Check in first, then view the event page
      const { event, cookie } = await checkinAction({})();

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
        bookableDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
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

  describe("GET /admin/attendees/:attendeeId", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockRequest(`/admin/attendees/${attendee.id}`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/attendees/999",
        { cookie },
      );
      expect(response.status).toBe(404);
    });

    test("shows edit form with prefilled attendee data", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "John Doe",
        email: "john@example.com",
        phone: "555-1234",
        address: "123 Main St",
        special_instructions: "VIP guest",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendee;

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Edit Attendee");
      expect(html).toContain("John Doe");
      expect(html).toContain("john@example.com");
      expect(html).toContain("555-1234");
      expect(html).toContain("123 Main St");
      expect(html).toContain("VIP guest");
    });

    test("includes return_url as hidden field when provided", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}?return_url=${encodeURIComponent("/admin/calendar#attendees")}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="return_url"');
      expect(html).toContain("/admin/calendar#attendees");
    });

    test("shows event selector with current event selected", async () => {
      const event = await createTestEvent({ name: "Current Event", maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Current Event");
      expect(html).toContain(`<option value="${event.id}" selected>`);
    });

    test("includes active events in selector", async () => {
      const event1 = await createTestEvent({ name: "Event 1", maxAttendees: 100 });
      await createTestEvent({ name: "Event 2", maxAttendees: 100, active: true });
      const attendee = await createTestAttendee(event1.id, event1.slug, "John Doe", "john@example.com");
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Event 1");
      expect(html).toContain("Event 2");
    });
  });

  describe("POST /admin/attendees/:attendeeId", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest(`/admin/attendees/${attendee.id}`, {
          name: "Jane Doe",
          email: "jane@example.com",
          phone: "",
          address: "",
          special_instructions: "",
          event_id: String(event.id),
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/999",
          {
            name: "Jane Doe",
            email: "jane@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: "1",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "Jane Doe",
            email: "jane@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects empty name", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "",
            email: "jane@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Name is required");
    });

    test("preserves return_url on edit validation error", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie, csrfToken } = await loginAsAdmin();
      const returnUrl = "/admin/calendar#attendees";

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "",
            email: "jane@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            csrf_token: csrfToken,
            return_url: returnUrl,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('name="return_url"');
      expect(html).toContain(returnUrl);
    });

    test("rejects whitespace-only name", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "   ",
            email: "jane@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Name is required");
    });

    test("rejects missing event_id", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "Jane Doe",
            email: "jane@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: "0",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Event is required");
    });

    test("updates attendee with new data", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "Jane Doe",
            email: "jane@example.com",
            phone: "555-9999",
            address: "456 Oak Ave",
            special_instructions: "Wheelchair access",
            event_id: String(event.id),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}?edited=Jane%20Doe#attendees`);

      // Verify the edit form shows the updated data
      const editResponse = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(editResponse.status).toBe(200);
      const html = await editResponse.text();
      expect(html).toContain("Jane Doe");
      expect(html).toContain("jane@example.com");
      expect(html).toContain("555-9999");
      expect(html).toContain("456 Oak Ave");
      expect(html).toContain("Wheelchair access");
    });

    test("allows moving attendee to different event", async () => {
      const event1 = await createTestEvent({ name: "Event 1", maxAttendees: 100 });
      const event2 = await createTestEvent({ name: "Event 2", maxAttendees: 100 });
      const attendee = await createTestAttendee(event1.id, event1.slug, "John Doe", "john@example.com");
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event2.id),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event2.id}?edited=John%20Doe#attendees`);

      // Verify attendee was moved to event2 by checking the raw attendee data
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated).not.toBeNull();
      expect(updated!.event_id).toBe(event2.id);
    });

    test("event page shows edit success message", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?edited=Jane%20Doe`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Updated Jane Doe");
    });

    test("attendee table shows edit link", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/event/${event.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`/admin/attendees/${attendee.id}`);
      expect(html).toContain("Edit");
    });

    test("shows current event and active events in selector", async () => {
      const event1 = await createTestEvent({ name: "Event 1", maxAttendees: 100, active: true });
      await createTestEvent({ name: "Event 2", maxAttendees: 100, active: true });
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event1.id,
        name: "John Doe",
        email: "john@example.com",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendee;

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Event 1");
      expect(html).toContain("Event 2");
      expect(html).toContain(`<option value="${event1.id}" selected>`);
    });

    test("shows edit form with empty email field", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "John Doe",
        email: "",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendee;

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('type="email"');
      expect(html).toContain('name="email"');
    });

    test("shows inactive event label in selector", async () => {
      const inactiveEvent = await createTestEvent({ name: "Inactive Event", maxAttendees: 100 });

      // Manually set event to inactive
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        sql: "UPDATE events SET active = 0 WHERE id = ?",
        args: [inactiveEvent.id],
      });

      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: inactiveEvent.id,
        name: "John Doe",
        email: "john@example.com",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendee;

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Inactive Event");
      expect(html).toContain("(inactive)");
    });

    test("updates attendee with empty email", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "John Doe",
        email: "john@example.com",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendee;

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });

    test("updates attendee with all non-empty fields", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "John Doe",
        email: "john@example.com",
        phone: "555-1234",
        address: "123 Main St",
        special_instructions: "VIP",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendee;

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "Jane Smith",
            email: "jane@example.com",
            phone: "555-9999",
            address: "456 Oak Ave",
            special_instructions: "Special access needed",
            event_id: String(event.id),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}?edited=Jane%20Smith#attendees`);
    });
  });

  describe("GET /admin/event/:eventId/attendee/:attendeeId/resend-webhook", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/attendee/${attendee.id}/resend-webhook`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/999/attendee/1/resend-webhook",
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({ maxAttendees: 100 });

      const { cookie } = await loginAsAdmin();

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/999/resend-webhook",
        { cookie: cookie },
      );
      expect(response.status).toBe(404);
    });

    test("shows resend webhook confirmation page when authenticated", async () => {
      const { response } = await adminEventPage(
        ctx => `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/resend-webhook`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Re-send Webhook");
      expect(html).toContain("John Doe");
      expect(html).toContain("type their name");
    });

    test("includes return_url as hidden field when provided", async () => {
      const { response } = await adminEventPage(
        ctx => `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/resend-webhook?return_url=${encodeURIComponent("/admin/calendar#attendees")}`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="return_url"');
      expect(html).toContain("/admin/calendar#attendees");
    });

    test("shows amount paid on resend webhook page for paid attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 1000 });

      // Create attendee with price_paid using createAttendeeAtomic
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "Jane Paid",
        email: "jane@example.com",
        quantity: 1,
        pricePaid: 1000,
        paymentId: "pi_test",
      });

      if (!result.success) {
        throw new Error("Failed to create attendee");
      }

      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${result.attendee.id}/resend-webhook`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Re-send Webhook");
      expect(html).toContain("Jane Paid");
      expect(html).toContain("Amount Paid");
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/resend-webhook", () => {
    const resendWebhookAction = adminAttendeeAction("resend-webhook");

    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee/${attendee.id}/resend-webhook`, {
          confirm_name: "John Doe",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/resend-webhook",
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
      await createTestEvent({ maxAttendees: 100 });

      const { cookie, csrfToken } = await loginAsAdmin();

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/resend-webhook",
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
      const { response } = await resendWebhookAction({ confirm_name: "John Doe", csrf_token: "invalid-token" })();
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).toContain("Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await resendWebhookAction({ confirm_name: "Wrong Name" })();
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("does not match");
    });

    test("re-sends webhook with matching name", async () => {
      const webhookFetch = spyOn(globalThis, "fetch");
      webhookFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { response, event } = await resendWebhookAction({ confirm_name: "John Doe" })({
        webhookUrl: "https://example.com/webhook",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/event/${event.id}`);

      // Verify webhook was sent
      expect(webhookFetch).toHaveBeenCalled();
      webhookFetch.mockRestore();
    });

    test("logs activity when webhook is re-sent", async () => {
      const webhookFetch = spyOn(globalThis, "fetch");
      webhookFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { response, event } = await resendWebhookAction({ confirm_name: "John Doe" })({
        webhookUrl: "https://example.com/webhook",
      });
      expect(response.status).toBe(302);

      // Verify activity was logged
      const { getEventActivityLog } = await import("#lib/db/activityLog.ts");
      const logs = await getEventActivityLog(event.id);
      const resendLog = logs.find((l: { message: string }) => l.message.includes("Webhook re-sent"));
      expect(resendLog).toBeDefined();
      expect(resendLog?.message).toContain("John Doe");
      webhookFetch.mockRestore();
    });
  });

  describe("payment details on edit page", () => {
    test("shows payment details for paid attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 1000 });
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "Paid User",
        email: "paid@example.com",
        quantity: 1,
        pricePaid: 1000,
        paymentId: "pi_test_123",
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(`/admin/attendees/${result.attendee.id}`, { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Payment Details");
      expect(html).toContain("pi_test_123");
      expect(html).toContain("Not refunded");
      expect(html).toContain("Refresh payment status");
    });

    test("shows refunded status for refunded attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 1000 });
      const { createAttendeeAtomic, markRefunded } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event.id,
        name: "Refunded User",
        email: "refunded@example.com",
        quantity: 1,
        pricePaid: 1000,
        paymentId: "pi_refunded_123",
      });
      if (!result.success) throw new Error("Failed to create attendee");
      await markRefunded(result.attendee.id);
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(`/admin/attendees/${result.attendee.id}`, { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Refunded");
    });

    test("shows success message when success query param is present", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}?success=${encodeURIComponent("Payment status is up to date")}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Payment status is up to date");
    });

    test("does not show payment details for free attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "Free User", "free@example.com");
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(`/admin/attendees/${attendee.id}`, { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Payment Details");
    });
  });

  describe("POST /admin/attendees/:attendeeId/refresh-payment", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const response = await handleRequest(
        mockFormRequest(`/admin/attendees/${attendee.id}/refresh-payment`, {}),
      );
      expectAdminRedirect(response);
    });

    test("redirects to edit page when attendee has no payment", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "John Doe", "john@example.com");
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}/refresh-payment`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/attendees/${attendee.id}`);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/999/refresh-payment",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns error when no payment provider configured", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_no_provider");
      const { cookie, csrfToken } = await loginAsAdmin();

      await withMocks(
        () => spyOn(paymentsApi, "getConfiguredProvider").mockResolvedValue(null),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              `/admin/attendees/${attendee.id}/refresh-payment`,
              { csrf_token: csrfToken },
              cookie,
            ),
          );
          expect(response.status).toBe(400);
          const html = await response.text();
          expect(html).toContain("payment provider");
        },
      );
    });

    test("marks as refunded when Stripe reports refund", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_refresh_refund");
      const { cookie, csrfToken } = await loginAsAdmin();

      await withMocks(
        () => spyOn(paymentsApi, "getConfiguredProvider").mockResolvedValue(mockProviderType("stripe")),
        async () => {
          const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
          const mockRefunded = spyOn(stripePaymentProvider, "isPaymentRefunded").mockResolvedValue(true);
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/attendees/${attendee.id}/refresh-payment`,
                { csrf_token: csrfToken },
                cookie,
              ),
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(`/admin/attendees/${attendee.id}`);
            expect(response.headers.get("location")).toContain("success=");
            expect(response.headers.get("location")).toContain("refunded");
            expect(mockRefunded).toHaveBeenCalledWith("pi_refresh_refund");
          } finally {
            mockRefunded.mockRestore?.();
          }
        },
      );
    });

    test("redirects without marking refunded when payment is not refunded", async () => {
      const event = await createTestEvent({ maxAttendees: 100, unitPrice: 500 });
      const attendee = await createPaidTestAttendee(event.id, "John Doe", "john@example.com", "pi_refresh_ok");
      const { cookie, csrfToken } = await loginAsAdmin();

      await withMocks(
        () => spyOn(paymentsApi, "getConfiguredProvider").mockResolvedValue(mockProviderType("stripe")),
        async () => {
          const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
          const mockRefunded = spyOn(stripePaymentProvider, "isPaymentRefunded").mockResolvedValue(false);
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/attendees/${attendee.id}/refresh-payment`,
                { csrf_token: csrfToken },
                cookie,
              ),
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(`/admin/attendees/${attendee.id}`);
            expect(response.headers.get("location")).toContain("success=");
            expect(response.headers.get("location")).toContain("up%20to%20date");
          } finally {
            mockRefunded.mockRestore?.();
          }
        },
      );
    });
  });

});
