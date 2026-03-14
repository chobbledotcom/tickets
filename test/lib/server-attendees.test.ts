import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#lib/db/attendees.ts";
import { paymentsApi } from "#lib/payments.ts";
import { handleRequest } from "#routes";
import {
  adminAttendeeAction,
  adminEventPage,
  awaitTestRequest,
  createPaidTestAttendee,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  expectAdminRedirect,
  expectHtmlResponse,
  expectRedirect,
  getAttendeesRaw,
  mockFormRequest,
  mockProviderType,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  setupEventAndLogin,
  testCookie,
  testCsrfToken,
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

  const deleteAction = adminAttendeeAction("delete");
  const checkinAction = adminAttendeeAction("checkin");

  describe("GET /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/attendee/${attendee.id}/delete`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await awaitTestRequest(
        "/admin/event/999/attendee/1/delete",
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/999/delete",
        { cookie: await testCookie() },
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
      const attendee = await createTestAttendee(
        event2.id,
        event2.slug,
        "John Doe",
        "john@example.com",
      );

      // Try to delete attendee from event 2 via event 1 URL
      const response = await awaitTestRequest(
        `/admin/event/${event1.id}/attendee/${attendee.id}/delete`,
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const { response } = await adminEventPage(
        (ctx) =>
          `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/delete`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Delete Attendee",
        "John Doe",
        "type their name",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const { response } = await adminEventPage(
        (ctx) =>
          `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/delete?return_url=${encodeURIComponent(
            "/admin/calendar#attendees",
          )}`,
      )();
      await expectHtmlResponse(
        response,
        200,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            confirm_name: "John Doe",
          },
        ),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/delete",
          {
            confirm_name: "John Doe",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/delete",
          {
            confirm_name: "John Doe",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await deleteAction({
        confirm_name: "John Doe",
        csrf_token: "invalid-token",
      })();
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await deleteAction({ confirm_name: "Wrong Name" })();
      await expectHtmlResponse(response, 400, "does not match");
    });

    test("preserves return_url on mismatched attendee name", async () => {
      const returnUrl = "/admin/calendar#attendees";
      const { response } = await deleteAction({
        confirm_name: "Wrong Name",
        return_url: returnUrl,
      })();
      await expectHtmlResponse(response, 400, 'name="return_url"', returnUrl);
    });

    test("deletes attendee with matching name (case insensitive)", async () => {
      const { response, event, attendee } = await deleteAction({
        confirm_name: "john doe",
      })();
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/admin/event/${event.id}?success=Attendee+deleted`,
      );

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("deletes attendee with whitespace-trimmed name", async () => {
      const { response } = await deleteAction({
        confirm_name: "  John Doe  ",
      })();
      expectRedirect("/admin/event/1?success=Attendee+deleted")(response);
    });
  });

  describe("DELETE /admin/event/:eventId/attendee/:attendeeId/delete", () => {
    test("deletes attendee with DELETE method", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const formBody = new URLSearchParams({
        confirm_name: "John Doe",
        csrf_token: await testCsrfToken(),
      }).toString();

      const response = await handleRequest(
        new Request(
          `http://localhost/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            method: "DELETE",
            headers: {
              host: "localhost",
              cookie: await testCookie(),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: formBody,
          },
        ),
      );
      expectRedirect("/admin/event/1?success=Attendee+deleted")(response);

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
      await expectHtmlResponse(response, 400, "does not match");
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("returns 404 for non-existent attendee on delete page", async () => {
      const { event, cookie } = await setupEventAndLogin({
        name: "Att Del 404",
        maxAttendees: 50,
      });

      const response = await handleRequest(
        new Request(
          `http://localhost/admin/event/${event.id}/attendee/99999/delete`,
          {
            headers: {
              host: "localhost",
              cookie,
            },
          },
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("exercises parseAttendeeIds via POST route with valid params", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        name: "Parse Ids Test",
        maxAttendees: 50,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Test User",
        "test@example.com",
      );

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

  describe("POST /admin/event/:eventId/attendee/:attendeeId/delete-incomplete", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "John Doe",
        "john@example.com",
        "",
        1000,
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete-incomplete`,
          {},
        ),
      );
      expectAdminRedirect(response);
    });

    test("deletes incomplete attendee without name confirmation", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "Jane Stuck",
        "jane@example.com",
        "",
        1000,
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expectRedirect(
        `/admin/event/${event.id}?success=Incomplete+registration+removed`,
      )(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("refuses to delete complete attendee via delete-incomplete", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "John Paid",
        "john@example.com",
        "pi_test_123",
        1000,
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/event/${event.id}`,
      );
      expect(response.headers.get("location")).toContain("error=");

      // Verify attendee was NOT deleted (still exists)
      const rows = await getAttendeesRaw(event.id);
      expect(rows.length).toBe(1);
    });

    test("refuses to delete admin-added attendee on paid event via delete-incomplete", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      // Admin-added attendee: no payment_id and price_paid=0
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Admin Added",
        "admin@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/event/${event.id}`,
      );
      expect(response.headers.get("location")).toContain("error=");

      // Verify attendee was NOT deleted
      const rows = await getAttendeesRaw(event.id);
      expect(rows.length).toBe(1);
    });

    test("deletes incomplete attendee on free can_pay_more event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        unitPrice: 0,
        canPayMore: true,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "Jane Stuck",
        "jane@example.com",
        "",
        500,
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expectRedirect(
        `/admin/event/${event.id}?success=Incomplete+registration+removed`,
      )(response);

      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("returns 404 for non-existent attendee", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        unitPrice: 1000,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/999/delete-incomplete`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/checkin", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/checkin`,
          {},
        ),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await checkinAction({
        csrf_token: "invalid-token",
      })();
      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/checkin",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/checkin",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
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
      const { response, event } = await checkinAction({
        return_filter: "in",
      })();
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
      const { response, event } = await checkinAction({
        return_filter: "all",
      })();
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`/admin/event/${event.id}?`);
      expect(location).not.toContain("/in?");
      expect(location).not.toContain("/out?");
    });

    test("redirects to return_url when provided", async () => {
      const { response } = await checkinAction({
        return_url: "/admin/calendar?date=2026-03-15#attendees",
      })();
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/admin/calendar");
      expect(location).toContain("date=2026-03-15");
      expect(location).toContain("success=");
      expect(location).toContain("checked");
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
      const { response } = await adminEventPage(
        (ctx) => `/admin/event/${ctx.event.id}`,
      )();
      await expectHtmlResponse(response, 200, "Check in", "/checkin");
    });

    test("event page shows check-in success message when query params present", async () => {
      const { response } = await adminEventPage(
        (ctx) =>
          `/admin/event/${ctx.event.id}?checkin_name=John%20Doe&checkin_status=in`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Checked John Doe in",
        "checkin-message-in",
      );
    });

    test("event page shows check-out message in red", async () => {
      const { response } = await adminEventPage(
        (ctx) =>
          `/admin/event/${ctx.event.id}?checkin_name=John%20Doe&checkin_status=out`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Checked John Doe out",
        "checkin-message-out",
      );
    });

    test("event page ignores invalid checkin_status param", async () => {
      const { response } = await adminEventPage(
        (ctx) =>
          `/admin/event/${ctx.event.id}?checkin_name=John%20Doe&checkin_status=invalid`,
      )();
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Checked John Doe");
    });

    test("event page shows Check out button for checked-in attendee", async () => {
      // Check in first, then view the event page
      const { event, cookie } = await checkinAction({})();

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(response, 200, "Check out");
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
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee",
          {
            name: "Jane Doe",
            email: "jane@example.com",
            quantity: "1",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("adds attendee to email event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        fields: "email",
      });

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
      expect(location).toContain("success=Added");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });

    test("adds attendee to phone event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        fields: "phone",
      });

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
      expect(response.headers.get("location")).toContain("success=Added");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });

    test("adds attendee to both event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
        fields: "email,phone",
      });

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
      expect(response.headers.get("location")).toContain("success=Added");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.quantity).toBe(2);
    });

    test("redirects with error on validation failure", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
      });

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
      expect(location).toContain("error=");
    });

    test("redirects with error when capacity exceeded", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendee(
        event.id,
        event.slug,
        "First",
        "first@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            name: "Second",
            email: "second@example.com",
            quantity: "1",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("error=");
      expect(location).toContain("spots");
    });

    test("redirects with error on encryption failure", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
      });

      await withMocks(
        () =>
          stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.resolve({
              success: false,
              reason: "encryption_error",
            }),
          ),
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
          expect(location).toContain("error=");
          expect(location).toContain("Encryption");
        },
      );
    });

    test("adds attendee to daily event with date", async () => {
      const { addDays } = await import("#lib/dates.ts");
      const { todayInTz } = await import("#lib/timezone.ts");
      const futureDate = addDays(todayInTz("UTC"), 7);

      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
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
      });

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
      expect(response.headers.get("location")).toContain("success=Added");

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.date).toBe(futureDate);
    });

    test("event page shows add attendee form", async () => {
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie,
      });
      await expectHtmlResponse(
        response,
        200,
        "Add Attendee",
        `/admin/event/${event.id}/attendee`,
        "Your Name",
        "Quantity",
      );
    });

    test("event page shows success message when ?success param present", async () => {
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?success=Added%20Jane%20Doe`,
        { cookie },
      );
      await expectHtmlResponse(response, 200, "Added Jane Doe");
    });

    test("event page shows error message when ?error param present", async () => {
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?error=Not%20enough%20spots`,
        { cookie },
      );
      await expectHtmlResponse(response, 200, "Not enough spots");
    });
  });

  describe("GET /admin/attendees/:attendeeId", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockRequest(`/admin/attendees/${attendee.id}`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      const response = await awaitTestRequest("/admin/attendees/999", {
        cookie: await testCookie(),
      });
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

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Edit Attendee",
        "John Doe",
        "john@example.com",
        "555-1234",
        "123 Main St",
        "VIP guest",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}?return_url=${encodeURIComponent(
          "/admin/calendar#attendees",
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });

    test("shows event selector with current event selected", async () => {
      const event = await createTestEvent({
        name: "Current Event",
        maxAttendees: 100,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Current Event",
        `<option value="${event.id}" selected>`,
      );
    });

    test("includes active events in selector", async () => {
      const event1 = await createTestEvent({
        name: "Event 1",
        maxAttendees: 100,
      });
      await createTestEvent({
        name: "Event 2",
        maxAttendees: 100,
        active: true,
      });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Event 1", "Event 2");
    });
  });

  describe("POST /admin/attendees/:attendeeId", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
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
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects empty name", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Name is required");
    });

    test("preserves return_url on edit validation error", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
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
            csrf_token: await testCsrfToken(),
            return_url: returnUrl,
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, 'name="return_url"', returnUrl);
    });

    test("rejects whitespace-only name", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Name is required");
    });

    test("rejects missing event_id", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Event is required");
    });

    test("updates attendee with new data", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
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
            quantity: "1",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/admin/event/${event.id}?success=Updated+Jane+Doe#attendees`,
      );

      // Verify the edit form shows the updated data
      const editResponse = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      expect(editResponse.status).toBe(200);
      const html = await editResponse.text();
      expect(html).toContain("Jane Doe");
      expect(html).toContain("jane@example.com");
      expect(html).toContain("555-9999");
      expect(html).toContain("456 Oak Ave");
      expect(html).toContain("Wheelchair access");
    });

    test("appends success message to return_url after edit", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const returnUrl = "/admin/calendar?date=2026-03-15#attendees";

      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            quantity: "1",
            csrf_token: await testCsrfToken(),
            return_url: returnUrl,
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/admin/calendar");
      expect(location).toContain("success=");
      expect(location).toContain("John+Doe");
      expect(location).toContain("#attendees");
    });

    test("allows moving attendee to different event", async () => {
      const event1 = await createTestEvent({
        name: "Event 1",
        maxAttendees: 100,
      });
      const event2 = await createTestEvent({
        name: "Event 2",
        maxAttendees: 100,
      });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "John Doe",
        "john@example.com",
      );
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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/admin/event/${event2.id}?success=Updated+John+Doe#attendees`,
      );

      // Verify attendee was moved to event2 by checking the raw attendee data
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated).not.toBeNull();
      expect(updated!.event_id).toBe(event2.id);
    });

    test("event page shows edit success message", async () => {
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?success=Updated%20Jane%20Doe`,
        { cookie },
      );
      await expectHtmlResponse(response, 200, "Updated Jane Doe");
    });

    test("attendee table shows edit link", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(`/admin/event/${event.id}`, {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        `/admin/attendees/${attendee.id}`,
        "Edit",
      );
    });

    test("shows current event and active events in selector", async () => {
      const event1 = await createTestEvent({
        name: "Event 1",
        maxAttendees: 100,
        active: true,
      });
      await createTestEvent({
        name: "Event 2",
        maxAttendees: 100,
        active: true,
      });
      const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
      const result = await createAttendeeAtomic({
        eventId: event1.id,
        name: "John Doe",
        email: "john@example.com",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendee;

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Event 1",
        "Event 2",
        `<option value="${event1.id}" selected>`,
      );
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

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, 'type="email"', 'name="email"');
    });

    test("shows inactive event label in selector", async () => {
      const inactiveEvent = await createTestEvent({
        name: "Inactive Event",
        maxAttendees: 100,
      });

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

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Inactive Event", "(inactive)");
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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
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
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/admin/event/${event.id}?success=Updated+Jane+Smith#attendees`,
      );
    });

    test("updates attendee quantity", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            quantity: "3",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);

      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated!.quantity).toBe(3);
    });

    test("shows quantity field on edit form", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, 'name="quantity"', 'max="5"');
    });

    test("clamps quantity to event max_quantity", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 3,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            quantity: "10",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);

      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated!.quantity).toBe(3);
    });

    test("rejects quantity increase when not enough spots", async () => {
      const event = await createTestEvent({ maxAttendees: 2, maxQuantity: 5 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            quantity: "3",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Not enough spots available");
    });

    test("allows decreasing quantity without capacity check", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
        3,
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            quantity: "1",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);

      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated!.quantity).toBe(1);
    });

    test("rejects non-existent event_id on quantity update", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: "9999",
            quantity: "2",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 400, "Event not found");
    });

    test("treats invalid quantity as 1", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            quantity: "abc",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);

      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated!.quantity).toBe(1);
    });

    test("defaults missing quantity to 1", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}`,
          {
            name: "John Doe",
            email: "john@example.com",
            phone: "",
            address: "",
            special_instructions: "",
            event_id: String(event.id),
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);

      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated!.quantity).toBe(1);
    });
  });

  describe("GET /admin/event/:eventId/attendee/:attendeeId/resend-notification", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/resend-notification`,
        ),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await awaitTestRequest(
        "/admin/event/999/attendee/1/resend-notification",
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({ maxAttendees: 100 });

      const response = await awaitTestRequest(
        "/admin/event/1/attendee/999/resend-notification",
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(404);
    });

    test("shows resend notification confirmation page when authenticated", async () => {
      const { response } = await adminEventPage(
        (ctx) =>
          `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/resend-notification`,
      )();
      await expectHtmlResponse(
        response,
        200,
        "Re-send Notification",
        "John Doe",
        "type their name",
      );
    });

    test("includes return_url as hidden field when provided", async () => {
      const { response } = await adminEventPage(
        (ctx) =>
          `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/resend-notification?return_url=${encodeURIComponent(
            "/admin/calendar#attendees",
          )}`,
      )();
      await expectHtmlResponse(
        response,
        200,
        'name="return_url"',
        "/admin/calendar#attendees",
      );
    });

    test("shows amount paid on resend notification page for paid attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 1000,
      });

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

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${result.attendee.id}/resend-notification`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Re-send Notification",
        "Jane Paid",
        "Amount Paid",
      );
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/resend-notification", () => {
    const resendNotificationAction = adminAttendeeAction("resend-notification");

    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/resend-notification`,
          {
            confirm_name: "John Doe",
          },
        ),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/999/attendee/1/resend-notification",
          {
            confirm_name: "John Doe",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({ maxAttendees: 100 });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/event/1/attendee/999/resend-notification",
          {
            confirm_name: "John Doe",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await resendNotificationAction({
        confirm_name: "John Doe",
        csrf_token: "invalid-token",
      })();
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await resendNotificationAction({
        confirm_name: "Wrong Name",
      })();
      await expectHtmlResponse(response, 400, "does not match");
    });

    test("re-sends notification with matching name", async () => {
      const webhookFetch = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response(null, { status: 200 })),
      );

      try {
        const { response, event } = await resendNotificationAction({
          confirm_name: "John Doe",
        })({
          webhookUrl: "https://example.com/webhook",
        });
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(
          `/admin/event/${event.id}?success=Notification+re-sent`,
        );

        // Verify webhook was sent
        expect(webhookFetch.calls.length).toBeGreaterThan(0);
      } finally {
        webhookFetch.restore();
      }
    });

    test("logs activity when notification is re-sent", async () => {
      const webhookFetch = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response(null, { status: 200 })),
      );

      try {
        const { response, event } = await resendNotificationAction({
          confirm_name: "John Doe",
        })({
          webhookUrl: "https://example.com/webhook",
        });
        expect(response.status).toBe(302);

        // Verify activity was logged
        const { getEventActivityLog } = await import("#lib/db/activityLog.ts");
        const logs = await getEventActivityLog(event.id);
        const resendLog = logs.find((l: { message: string }) =>
          l.message.includes("Notification re-sent"),
        );
        expect(resendLog).toBeDefined();
        expect(resendLog?.message).toContain("John Doe");
      } finally {
        webhookFetch.restore();
      }
    });
  });

  describe("payment details on edit page", () => {
    test("shows payment details for paid attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 1000,
      });
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
      const response = await awaitTestRequest(
        `/admin/attendees/${result.attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Payment Details",
        "pi_test_123",
        "Not refunded",
        "Refresh payment status",
      );
    });

    test("shows refunded status for refunded attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 1000,
      });
      const { createAttendeeAtomic, markRefunded } = await import(
        "#lib/db/attendees.ts"
      );
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
      const response = await awaitTestRequest(
        `/admin/attendees/${result.attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Refunded");
    });

    test("shows success message when success query param is present", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}?success=${encodeURIComponent(
          "Payment status is up to date",
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Payment status is up to date");
    });

    test("does not show payment details for free attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Free User",
        "free@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Payment Details");
    });
  });

  describe("POST /admin/attendees/:attendeeId/refresh-payment", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(`/admin/attendees/${attendee.id}/refresh-payment`, {}),
      );
      expectAdminRedirect(response);
    });

    test("redirects to edit page when attendee has no payment", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(
          `/admin/attendees/${attendee.id}/refresh-payment`,
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/admin/attendees/${attendee.id}?error=No+payment+to+refresh`,
      );
    });

    test("returns 404 for non-existent attendee", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/999/refresh-payment",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(404);
    });

    test("returns error when no payment provider configured", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "John Doe",
        "john@example.com",
        "pi_no_provider",
      );
      await withMocks(
        () =>
          stub(paymentsApi, "getConfiguredProvider", () =>
            Promise.resolve(null),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              `/admin/attendees/${attendee.id}/refresh-payment`,
              { csrf_token: await testCsrfToken() },
              await testCookie(),
            ),
          );
          await expectHtmlResponse(response, 400, "payment provider");
        },
      );
    });

    test("marks as refunded when Stripe reports refund", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "John Doe",
        "john@example.com",
        "pi_refresh_refund",
      );
      await withMocks(
        () =>
          stub(paymentsApi, "getConfiguredProvider", () =>
            Promise.resolve(mockProviderType("stripe")),
          ),
        async () => {
          const { stripePaymentProvider } = await import(
            "#lib/stripe-provider.ts"
          );
          const mockRefunded = stub(
            stripePaymentProvider,
            "isPaymentRefunded",
            () => Promise.resolve(true),
          );
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/attendees/${attendee.id}/refresh-payment`,
                { csrf_token: await testCsrfToken() },
                await testCookie(),
              ),
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(
              `/admin/attendees/${attendee.id}`,
            );
            expect(response.headers.get("location")).toContain("success=");
            expect(response.headers.get("location")).toContain("refunded");
            expect(mockRefunded.calls[0]!.args).toEqual(["pi_refresh_refund"]);
          } finally {
            mockRefunded.restore();
          }
        },
      );
    });

    test("redirects without marking refunded when payment is not refunded", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "John Doe",
        "john@example.com",
        "pi_refresh_ok",
      );
      await withMocks(
        () =>
          stub(paymentsApi, "getConfiguredProvider", () =>
            Promise.resolve(mockProviderType("stripe")),
          ),
        async () => {
          const { stripePaymentProvider } = await import(
            "#lib/stripe-provider.ts"
          );
          const mockRefunded = stub(
            stripePaymentProvider,
            "isPaymentRefunded",
            () => Promise.resolve(false),
          );
          try {
            const response = await handleRequest(
              mockFormRequest(
                `/admin/attendees/${attendee.id}/refresh-payment`,
                { csrf_token: await testCsrfToken() },
                await testCookie(),
              ),
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(
              `/admin/attendees/${attendee.id}`,
            );
            expect(response.headers.get("location")).toContain("success=");
            expect(response.headers.get("location")).toContain("up+to+date");
          } finally {
            mockRefunded.restore();
          }
        },
      );
    });
  });
});
