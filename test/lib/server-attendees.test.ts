import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#lib/db/attendees.ts";
import {
  answersTable,
  questionsTable,
  setEventQuestions,
} from "#lib/db/questions.ts";
import { paymentsApi } from "#lib/payments.ts";
import { handleRequest } from "#routes";
import {
  adminAttendeeAction,
  adminEventPage,
  adminFormPost,
  assertAdminHtml,
  awaitTestRequest,
  bookAttendee,
  createPaidTestAttendee,
  createTestAttendee,
  createTestAttendeeDirect,
  createTestEvent,
  describeWithEnv,
  expectAdminRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  followRedirectWithFlash,
  extractInputValue,
  getAttendeesRaw,
  mockFormRequest,
  mockProviderType,
  mockRequest,
  setupAdminTest,
  setupEventAndLogin,
  testCookie,
  testCsrfToken,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin attendees)", { db: true }, () => {
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
        maxAttendees: 100,
        name: "Event 1",
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        maxAttendees: 100,
        name: "Event 2",
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
            confirm_identifier: "John Doe",
          },
        ),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await adminFormPost(
        "/admin/event/999/attendee/1/delete",
        { confirm_identifier: "John Doe" },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        "/admin/event/1/attendee/999/delete",
        { confirm_identifier: "John Doe" },
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "John Doe",
        csrf_token: "invalid-token",
      })();
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "Wrong Name",
      })();
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("preserves return_url on mismatched attendee name", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "Wrong Name",
        return_url: "/admin/calendar#attendees",
      })();
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("deletes attendee with matching name (case insensitive)", async () => {
      const { response, event, attendee } = await deleteAction({
        confirm_identifier: "john doe",
      })();
      expectRedirectWithFlash(
        `/admin/event/${event.id}`,
        "Attendee deleted",
      )(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(attendee.id);
      expect(deleted).toBeNull();
    });

    test("deletes attendee with whitespace-trimmed name", async () => {
      const { response } = await deleteAction({
        confirm_identifier: "  John Doe  ",
      })();
      expectRedirectWithFlash("/admin/event/1", "Attendee deleted")(response);
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
        confirm_identifier: "John Doe",
        csrf_token: await testCsrfToken(),
      }).toString();

      const response = await handleRequest(
        new Request(
          `http://localhost/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          {
            body: formBody,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: await testCookie(),
              host: "localhost",
            },
            method: "DELETE",
          },
        ),
      );
      expectRedirectWithFlash("/admin/event/1", "Attendee deleted")(response);

      // Verify attendee was deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deletedAttendee = await getAttendeeRaw(1);
      expect(deletedAttendee).toBeNull();
    });
  });

  describe("POST /admin/event/:eventId/attendee/:attendeeId/delete (confirm_identifier edge case)", () => {
    test("handles missing confirm_identifier field (falls back to empty string)", async () => {
      // Submit without confirm_identifier field at all
      const { response } = await deleteAction({})();
      // Empty string won't match "John Doe", so it redirects with error
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });
  });

  describe("routes/admin/attendees.ts (parseAttendeeIds)", () => {
    test("returns 404 for non-existent attendee on delete page", async () => {
      const { event, cookie } = await setupEventAndLogin({
        maxAttendees: 50,
        name: "Att Del 404",
      });

      const response = await handleRequest(
        new Request(
          `http://localhost/admin/event/${event.id}/attendee/99999/delete`,
          {
            headers: {
              cookie,
              host: "localhost",
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
        maxAttendees: 50,
        name: "Parse Ids Test",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Test User",
        "test@example.com",
      );

      // POST route exercises attendeeDeleteHandler which calls parseAttendeeIds.
      // The custom handler requires confirm_identifier to match the attendee name.
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/delete`,
          { confirm_identifier: "Test User", csrf_token: csrfToken },
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
      expectRedirectWithFlash(
        `/admin/event/${event.id}`,
        "Incomplete registration removed",
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
      expectRedirectWithFlash(
        `/admin/event/${event.id}`,
        undefined,
        false,
      )(response);

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
      expectRedirectWithFlash(
        `/admin/event/${event.id}`,
        undefined,
        false,
      )(response);

      // Verify attendee was NOT deleted
      const rows = await getAttendeesRaw(event.id);
      expect(rows.length).toBe(1);
    });

    test("deletes incomplete attendee on free can_pay_more event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        canPayMore: true,
        maxAttendees: 100,
        unitPrice: 0,
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
      expectRedirectWithFlash(
        `/admin/event/${event.id}`,
        "Incomplete registration removed",
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

      const { response } = await adminFormPost(
        "/admin/event/1/attendee/999/checkin",
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await adminFormPost(
        "/admin/event/999/attendee/1/checkin",
      );
      expect(response.status).toBe(404);
    });

    test("checks in an attendee and redirects with message", async () => {
      const { response, event } = await checkinAction({})();
      expectRedirect(
        response,
        `/admin/event/${event.id}`,
        "checkin_status=in",
        "checkin_name=John",
        "#message",
      );
    });

    test("redirects to filtered page when return_filter is set", async () => {
      const { response, event } = await checkinAction({
        return_filter: "in",
      })();
      expectRedirect(
        response,
        `/admin/event/${event.id}/in?`,
        "checkin_status=in",
      );
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
      expectRedirect(
        response,
        `/admin/event/${event.id}/out?`,
        "checkin_status=out",
      );
    });

    test("redirects to unfiltered page when return_filter is all", async () => {
      const { response, event } = await checkinAction({
        return_filter: "all",
      })();
      const location = expectRedirect(response, `/admin/event/${event.id}?`);
      expect(location).not.toContain("/in?");
      expect(location).not.toContain("/out?");
    });

    test("redirects to return_url when provided", async () => {
      const { response } = await checkinAction({
        return_url: "/admin/calendar?date=2026-03-15#attendees",
      })();
      expectRedirect(
        response,
        "/admin/calendar",
        "date=2026-03-15",
        "#attendees",
      );
      expectFlash(response, expect.stringContaining("Checked"));
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
      expectRedirect(response, "checkin_status=out");
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
      const { event } = await checkinAction({})();

      await assertAdminHtml(`/admin/event/${event.id}`, "Check out");
    });
  });

  describe("POST /admin/event/:eventId/attendee (add attendee)", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });

      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/attendee`, {
          email: "jane@example.com",
          name: "Jane Doe",
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
            csrf_token: "invalid-token",
            email: "jane@example.com",
            name: "Jane Doe",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await adminFormPost("/admin/event/999/attendee", {
        email: "jane@example.com",
        name: "Jane Doe",
        quantity: "1",
      });
      expect(response.status).toBe(404);
    });

    test("adds attendee to email event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        fields: "email",
        maxAttendees: 100,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            csrf_token: csrfToken,
            email: "jane@example.com",
            name: "Jane Doe",
            quantity: "1",
          },
          cookie,
        ),
      );
      expectRedirect(response, `/admin/event/${event.id}`);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });

    test("adds attendee to phone event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        fields: "phone",
        maxAttendees: 100,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            csrf_token: csrfToken,
            name: "Phone User",
            phone: "+1234567890",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
    });

    test("adds attendee to both event", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        fields: "email,phone",
        maxAttendees: 100,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            csrf_token: csrfToken,
            email: "both@example.com",
            name: "Both User",
            phone: "+1234567890",
            quantity: "2",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Added"));

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
            csrf_token: csrfToken,
            email: "",
            name: "",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining(""), false);
    });

    test("redirects with error when capacity exceeded", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendee(
        event.id,
        event.slug,
        "First",
        "first@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/event/${event.id}/attendee`,
        {
          email: "second@example.com",
          name: "Second",
          quantity: "1",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("spots"), false);
    });

    test("redirects with error on encryption failure", async () => {
      const { event, cookie, csrfToken } = await setupEventAndLogin({
        maxAttendees: 100,
      });

      await withMocks(
        () =>
          stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.resolve({
              reason: "encryption_error",
              success: false,
            }),
          ),
        async () => {
          const response = await handleRequest(
            mockFormRequest(
              `/admin/event/${event.id}/attendee`,
              {
                csrf_token: csrfToken,
                email: "enc@example.com",
                name: "Enc Fail",
                quantity: "1",
              },
              cookie,
            ),
          );
          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("Encryption"), false);
        },
      );
    });

    test("adds attendee to daily event with date", async () => {
      const { addDays } = await import("#lib/dates.ts");
      const { todayInTz } = await import("#lib/timezone.ts");
      const futureDate = addDays(todayInTz("UTC"), 7);

      const { event, cookie, csrfToken } = await setupEventAndLogin({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        eventType: "daily",
        maxAttendees: 100,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee`,
          {
            csrf_token: csrfToken,
            date: futureDate,
            email: "daily@example.com",
            name: "Daily User",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Added"));

      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.date).toBe(futureDate);
    });

    test("event page shows add attendee form", async () => {
      const { event } = await setupEventAndLogin({ maxAttendees: 100 });

      await assertAdminHtml(
        `/admin/event/${event.id}`,
        "Add Attendee",
        `/admin/event/${event.id}/attendee`,
        "Your Name",
        "Quantity",
      );
    });

    test("event page shows success message when flash cookie present", async () => {
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Added Jane Doe")}`,
        },
      );
      await expectHtmlResponse(response, 200, "Added Jane Doe");
    });

    test("event page shows error message when flash cookie present", async () => {
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Not enough spots", false)}`,
        },
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
      const result = await bookAttendee(event, {
        address: "123 Main St",
        email: "john@example.com",
        name: "John Doe",
        phone: "555-1234",
        quantity: 1,
        special_instructions: "VIP guest",
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendees[0]!;

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

    test("shows current event in registrations table", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        name: "Current Event",
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
        "Event Registrations",
      );
    });

    test("edit page shows event registrations and add-to-event sections", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        name: "Edit Page Event",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Edit User",
        "edit@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(
        response,
        200,
        "Event Registrations",
        "Add to Event",
        "Save Contact Info",
      );
      // Event link table shows the event
      expect(html).toContain("Edit Page Event");
      // Add-to-event section has event selector
      expect(html).toContain("add_event_id");
    });

    test("edit page shows checked-in badge for checked-in attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        name: "Checkin Badge Event",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Badge User",
        "badge@example.com",
      );
      const { updateCheckedIn } = await import("#lib/db/attendees.ts");
      await updateCheckedIn(attendee.id, event.id, true);
      const { invalidateEventsCache } = await import("#lib/db/events.ts");
      invalidateEventsCache();
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Checked in");
    });

    test("edit page loads available dates for daily events", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        maxAttendees: 100,
        name: "Daily Dates Event",
      });
      const result = await bookAttendee(event, {
        date: "2026-04-07",
        email: "daily@example.com",
        name: "Daily User",
      });
      if (!result.success) throw new Error("Failed");
      const attendeeId = result.attendees[0]!.id;
      const response = await awaitTestRequest(
        `/admin/attendees/${attendeeId}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(
        response,
        200,
        "Daily Dates Event",
        "available-dates-data",
      );
      expect(html).toContain("2026-");
    });

    test("includes active events in add-to-event selector", async () => {
      const event1 = await createTestEvent({
        maxAttendees: 100,
        name: "Event 1",
      });
      await createTestEvent({
        active: true,
        maxAttendees: 100,
        name: "Event 2",
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
          address: "",
          email: "jane@example.com",
          event_id: String(event.id),
          name: "Jane Doe",
          phone: "",
          special_instructions: "",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { response } = await adminFormPost("/admin/attendees/999", {
        address: "",
        email: "jane@example.com",
        event_id: "1",
        name: "Jane Doe",
        phone: "",
        special_instructions: "",
      });
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
            address: "",
            csrf_token: "invalid-token",
            email: "jane@example.com",
            event_id: String(event.id),
            name: "Jane Doe",
            phone: "",
            special_instructions: "",
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
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "jane@example.com",
          event_id: String(event.id),
          name: "",
          phone: "",
          special_instructions: "",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Name is required"), false);
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

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "jane@example.com",
          event_id: String(event.id),
          name: "",
          phone: "",
          return_url: returnUrl,
          special_instructions: "",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Name is required"), false);
    });

    test("rejects whitespace-only name", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "jane@example.com",
          event_id: String(event.id),
          name: "   ",
          phone: "",
          special_instructions: "",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Name is required"), false);
    });

    test("updates attendee with new data", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "456 Oak Ave",
          email: "jane@example.com",
          event_id: String(event.id),
          name: "Jane Doe",
          phone: "555-9999",
          quantity: "1",
          special_instructions: "Wheelchair access",
        },
      );
      expect(response.status).toBe(302);
      expectRedirectWithFlash(
        `/admin/event/${event.id}#attendees`,
        "Updated Jane Doe",
      )(response);

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

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "john@example.com",
          event_id: String(event.id),
          name: "John Doe",
          phone: "",
          quantity: "1",
          return_url: returnUrl,
          special_instructions: "",
        },
      );
      expectRedirect(
        response,
        "/admin/calendar",
        "date=2026-03-15",
        "#attendees",
      );
      expectFlash(response, expect.stringContaining("John Doe"));
    });

    test("updates attendee PII via edit form", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        name: "Event 1",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "jane@example.com",
          name: "Jane Smith",
          phone: "",
          special_instructions: "",
        },
      );
      expect(response.status).toBe(302);
      expectRedirectWithFlash(
        `/admin/event/${event.id}#attendees`,
        "Updated Jane Smith",
      )(response);
    });

    test("preserves quantity when editing contact info without quantity field", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { attendee } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
        3,
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "jane@example.com",
          name: "Jane Doe",
          phone: "",
          special_instructions: "",
        },
      );
      expect(response.status).toBe(302);

      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const updated = await getAttendeeRaw(attendee.id);
      expect(updated!.quantity).toBe(3);
    });

    test("event page shows edit success message", async () => {
      const { event, cookie } = await setupEventAndLogin({ maxAttendees: 100 });

      const response = await awaitTestRequest(
        `/admin/event/${event.id}?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Updated Jane Doe")}`,
        },
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

    test("shows current event in registrations and active events in add-to-event", async () => {
      const event1 = await createTestEvent({
        active: true,
        maxAttendees: 100,
        name: "Event 1",
      });
      await createTestEvent({
        active: true,
        maxAttendees: 100,
        name: "Event 2",
      });
      const result = await bookAttendee(event1, {
        email: "john@example.com",
        name: "John Doe",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendees[0]!;

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Event 1",
        "Event 2",
        "Add to Event",
      );
    });

    test("shows edit form with empty email field", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const result = await bookAttendee(event, {
        email: "",
        name: "John Doe",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendees[0]!;

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, 'type="email"', 'name="email"');
    });

    test("shows inactive event in registrations table", async () => {
      const inactiveEvent = await createTestEvent({
        maxAttendees: 100,
        name: "Inactive Event",
      });

      const result = await bookAttendee(inactiveEvent, {
        email: "john@example.com",
        name: "John Doe",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendees[0]!;

      // Manually set event to inactive after creating attendee
      const { getDb } = await import("#lib/db/client.ts");
      await getDb().execute({
        args: [inactiveEvent.id],
        sql: "UPDATE events SET active = 0 WHERE id = ?",
      });

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      // Event still shows in registrations table even when inactive
      await expectHtmlResponse(
        response,
        200,
        "Inactive Event",
        "Event Registrations",
      );
    });

    test("updates attendee with empty email", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const result = await bookAttendee(event, {
        email: "john@example.com",
        name: "John Doe",
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendees[0]!;

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "",
          event_id: String(event.id),
          name: "John Doe",
          phone: "",
          special_instructions: "",
        },
      );
      expect(response.status).toBe(302);
    });

    test("updates attendee with all non-empty fields", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const result = await bookAttendee(event, {
        address: "123 Main St",
        email: "john@example.com",
        name: "John Doe",
        phone: "555-1234",
        quantity: 1,
        special_instructions: "VIP",
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const attendee = result.attendees[0]!;

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "456 Oak Ave",
          email: "jane@example.com",
          event_id: String(event.id),
          name: "Jane Smith",
          phone: "555-9999",
          special_instructions: "Special access needed",
        },
      );
      expect(response.status).toBe(302);
      expectRedirectWithFlash(
        `/admin/event/${event.id}#attendees`,
        "Updated Jane Smith",
      )(response);
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

    test("shows error message when attendee name does not match", async () => {
      const { event, attendee, cookie, csrfToken } = await setupAdminTest();
      const postResponse = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/attendee/${attendee.id}/resend-notification`,
          { confirm_identifier: "Wrong Name", csrf_token: csrfToken },
          cookie,
        ),
      );
      const page = await followRedirectWithFlash(
        postResponse,
        handleRequest,
        cookie,
      );
      const html = await page.text();
      expect(html).toContain("does not match");
    });

    test("shows amount paid on resend notification page for paid attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        unitPrice: 1000,
      });

      const result = await bookAttendee(event, {
        email: "jane@example.com",
        name: "Jane Paid",
        paymentId: "pi_test",
        pricePaid: 1000,
        quantity: 1,
      });

      if (!result.success) {
        throw new Error("Failed to create attendee");
      }

      const response = await awaitTestRequest(
        `/admin/event/${event.id}/attendee/${
          result.attendees[0]!.id
        }/resend-notification`,
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
            confirm_identifier: "John Doe",
          },
        ),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await adminFormPost(
        "/admin/event/999/attendee/1/resend-notification",
        { confirm_identifier: "John Doe" },
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for non-existent attendee", async () => {
      await createTestEvent({ maxAttendees: 100 });

      const { response } = await adminFormPost(
        "/admin/event/1/attendee/999/resend-notification",
        { confirm_identifier: "John Doe" },
      );
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { response } = await resendNotificationAction({
        confirm_identifier: "John Doe",
        csrf_token: "invalid-token",
      })();
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched attendee name", async () => {
      const { response } = await resendNotificationAction({
        confirm_identifier: "Wrong Name",
      })();
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("re-sends notification with matching name", async () => {
      const webhookFetch = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response(null, { status: 200 })),
      );

      try {
        const { response, event } = await resendNotificationAction({
          confirm_identifier: "John Doe",
        })({
          webhookUrl: "https://example.com/webhook",
        });
        expect(response.status).toBe(302);
        expectRedirectWithFlash(
          `/admin/event/${event.id}`,
          "Notification re-sent",
        )(response);

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
          confirm_identifier: "John Doe",
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
      const result = await bookAttendee(event, {
        email: "paid@example.com",
        name: "Paid User",
        paymentId: "pi_test_123",
        pricePaid: 1000,
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      const response = await awaitTestRequest(
        `/admin/attendees/${result.attendees[0]!.id}`,
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
      const { markRefunded } = await import("#lib/db/attendees.ts");
      const result = await bookAttendee(event, {
        email: "refunded@example.com",
        name: "Refunded User",
        paymentId: "pi_refunded_123",
        pricePaid: 1000,
        quantity: 1,
      });
      if (!result.success) throw new Error("Failed to create attendee");
      await markRefunded(result.attendees[0]!.id, event.id);
      const response = await awaitTestRequest(
        `/admin/attendees/${result.attendees[0]!.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Refunded");
    });

    test("shows success message when flash cookie present", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader(
            "Payment status is up to date",
          )}`,
        },
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
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );
      expect(response.status).toBe(302);
      expectRedirectWithFlash(
        `/admin/attendees/${attendee.id}`,
        "No payment to refresh",
        false,
      )(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      const { response } = await adminFormPost(
        "/admin/attendees/999/refresh-payment",
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
        () => stub(paymentsApi, "getConfiguredProvider", () => null),
        async () => {
          const { response } = await adminFormPost(
            `/admin/attendees/${attendee.id}/refresh-payment`,
          );
          expect(response.status).toBe(302);
          expectFlash(
            response,
            expect.stringContaining("payment provider"),
            false,
          );
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
            mockProviderType("stripe"),
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
            const { response } = await adminFormPost(
              `/admin/attendees/${attendee.id}/refresh-payment`,
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(
              `/admin/attendees/${attendee.id}`,
            );
            expectFlash(response, expect.stringContaining("refunded"));
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
            mockProviderType("stripe"),
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
            const { response } = await adminFormPost(
              `/admin/attendees/${attendee.id}/refresh-payment`,
            );
            expect(response.status).toBe(302);
            expect(response.headers.get("location")).toContain(
              `/admin/attendees/${attendee.id}`,
            );
            expectFlash(response, expect.stringContaining("up to date"));
          } finally {
            mockRefunded.restore();
          }
        },
      );
    });
  });

  describe("edit attendee questions", () => {
    const setupQuestionAndAttendee = async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      // Create attendee before assigning questions (public route requires answers)
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const q = await questionsTable.insert({ text: "T-shirt size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });
      await setEventQuestions(event.id, [q.id]);
      return { a1, a2, attendee, event, q };
    };

    test("shows questions on edit page", async () => {
      const { attendee } = await setupQuestionAndAttendee();
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "T-shirt size?",
        "Small",
        "Large",
      );
    });

    test("pre-selects existing answer on edit page", async () => {
      const { attendee, a1 } = await setupQuestionAndAttendee();
      const { saveAttendeeAnswers } = await import("#lib/db/questions.ts");
      await saveAttendeeAnswers([attendee.id], [a1.id]);

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await response.text();
      expect(html).toContain(`value="${a1.id}" checked`);
    });

    test("does not show questions when event has none", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Jane Doe",
        "jane@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await response.text();
      expect(html).not.toContain("custom-question");
    });

    test("saves selected answer on edit", async () => {
      const { event, attendee, q, a2 } = await setupQuestionAndAttendee();
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "john@example.com",
          event_id: String(event.id),
          name: "John Doe",
          phone: "",
          quantity: "1",
          special_instructions: "",
          [`question_${q.id}`]: String(a2.id),
        },
      );
      expect(response.status).toBe(302);

      const { getAttendeeAnswersBatch } = await import("#lib/db/questions.ts");
      const answers = await getAttendeeAnswersBatch([attendee.id]);
      expect(answers.get(attendee.id)).toEqual([a2.id]);
    });

    test("updates answer from one option to another", async () => {
      const { event, attendee, q, a1, a2 } = await setupQuestionAndAttendee();
      const { saveAttendeeAnswers, getAttendeeAnswersBatch } = await import(
        "#lib/db/questions.ts"
      );
      await saveAttendeeAnswers([attendee.id], [a1.id]);

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "john@example.com",
          event_id: String(event.id),
          name: "John Doe",
          phone: "",
          quantity: "1",
          special_instructions: "",
          [`question_${q.id}`]: String(a2.id),
        },
      );
      expect(response.status).toBe(302);

      const answers = await getAttendeeAnswersBatch([attendee.id]);
      expect(answers.get(attendee.id)).toEqual([a2.id]);
    });

    test("clears answers when no question field submitted", async () => {
      const { event, attendee, a1 } = await setupQuestionAndAttendee();
      const { saveAttendeeAnswers, getAttendeeAnswersBatch } = await import(
        "#lib/db/questions.ts"
      );
      await saveAttendeeAnswers([attendee.id], [a1.id]);

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "john@example.com",
          event_id: String(event.id),
          name: "John Doe",
          phone: "",
          quantity: "1",
          special_instructions: "",
        },
      );
      expect(response.status).toBe(302);

      const answers = await getAttendeeAnswersBatch([attendee.id]);
      const attendeeAnswers = answers.get(attendee.id) ?? [];
      expect(attendeeAnswers.length).toBe(0);
    });

    test("ignores invalid answer ID for question", async () => {
      const { event, attendee, q } = await setupQuestionAndAttendee();

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          address: "",
          email: "john@example.com",
          event_id: String(event.id),
          name: "John Doe",
          phone: "",
          quantity: "1",
          special_instructions: "",
          [`question_${q.id}`]: "99999",
        },
      );
      expect(response.status).toBe(302);

      const { getAttendeeAnswersBatch } = await import("#lib/db/questions.ts");
      const answers = await getAttendeeAnswersBatch([attendee.id]);
      const attendeeAnswers = answers.get(attendee.id) ?? [];
      expect(attendeeAnswers.length).toBe(0);
    });
  });

  describe("event link management", () => {
    test("POST /admin/attendees/:id/link adds event link", async () => {
      const event1 = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const event2 = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "Link User",
        "link@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/link`,
        { event_id: String(event2.id), quantity: "2" },
      );
      expect(response.status).toBe(302);

      // Verify attendee is linked to both events
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const att1 = await getAttendeesRaw(event1.id);
      const att2 = await getAttendeesRaw(event2.id);
      expect(att1.length).toBe(1);
      expect(att2.length).toBe(1);
      expect(att2[0]!.quantity).toBe(2);
    });

    test("POST /admin/attendees/:id/link rejects missing event_id", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "No Event",
        "noevent@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/link`,
        { event_id: "0", quantity: "1" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Event is required"),
        false,
      );
    });

    test("POST /admin/attendees/:id/link rejects when capacity exceeded", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 1 });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "Cap",
        "cap@test.com",
      );
      // Fill event2
      await createTestAttendee(
        event2.id,
        event2.slug,
        "Filler",
        "filler@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/link`,
        { event_id: String(event2.id), quantity: "1" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Not enough spots"), false);
    });

    test("POST /admin/attendees/:id/link rejects non-existent event", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Bad",
        "bad@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/link`,
        { event_id: "99999", quantity: "1" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Event not found"), false);
    });

    test("POST /admin/attendees/:id/unlink/:eventId removes event link", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const { createAttendeeAtomic: create } = await import(
        "#lib/db/attendees.ts"
      );
      const result = await create({
        bookings: [{ eventId: event1.id }, { eventId: event2.id }],
        email: "unlink@test.com",
        name: "Unlink",
      });
      if (!result.success) throw new Error("Failed to create");
      const attendeeId = result.attendees[0]!.id;

      const { response } = await adminFormPost(
        `/admin/attendees/${attendeeId}/unlink/${event1.id}`,
      );
      expect(response.status).toBe(302);

      // Attendee still linked to event2
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      expect((await getAttendeesRaw(event1.id)).length).toBe(0);
      expect((await getAttendeesRaw(event2.id)).length).toBe(1);
    });

    test("POST /admin/attendees/:id/unlink/:eventId blocks removing last event", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "LastLink",
        "lastlink@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/unlink/${event.id}`,
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("delete the attendee instead"),
        false,
      );
    });

    test("POST /admin/attendees/:id/event/:eventId updates quantity", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 10,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Qty",
        "qty@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/event/${event.id}`,
        { quantity: "5" },
      );
      expect(response.status).toBe(302);

      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const raw = await getAttendeesRaw(event.id);
      expect(raw[0]!.quantity).toBe(5);
    });

    test("POST /admin/attendees/:id/event/:eventId rejects over-capacity", async () => {
      const event = await createTestEvent({
        maxAttendees: 3,
        maxQuantity: 10,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Over",
        "over@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/event/${event.id}`,
        { quantity: "5" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Not enough spots"), false);
    });

    test("POST /admin/attendees/:id/event/:eventId rejects non-existent event", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Missing",
        "missing@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/event/99999`,
        { quantity: "1" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Event not found"), false);
    });

    test("POST /admin/attendees/:id/link defaults missing quantity to 1", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "Default Qty",
        "dq@test.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/link`,
        { event_id: String(event2.id) },
      );
      expect(response.status).toBe(302);
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const raw = await getAttendeesRaw(event2.id);
      expect(raw[0]!.quantity).toBe(1);
    });

    test("POST /admin/attendees/:id/link handles daily event without date", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({
        eventType: "daily",
        maxAttendees: 50,
      });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "No Date",
        "nodate@test.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/link`,
        { date: "", event_id: String(event2.id) },
      );
      expect(response.status).toBe(302);
    });

    test("POST /admin/attendees/:id/link handles daily event with date", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({
        eventType: "daily",
        maxAttendees: 50,
      });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "Daily Link",
        "dl@test.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/link`,
        { date: "2026-04-07", event_id: String(event2.id) },
      );
      expect(response.status).toBe(302);
      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const raw = await getAttendeesRaw(event2.id);
      expect(raw[0]!.date).toBe("2026-04-07");
    });

    test("POST /admin/attendees/:id/event/:eventId defaults missing quantity to 1", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Upd Qty",
        "uq@test.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/event/${event.id}`,
      );
      expect(response.status).toBe(302);
    });

    test("POST /admin/attendees/:id/event/:eventId handles standard event (no date)", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Std Upd",
        "su@test.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/event/${event.id}`,
        { date: "", quantity: "2" },
      );
      expect(response.status).toBe(302);
    });

    test("POST /admin/attendees/:id/event/:eventId handles daily event without date", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        maxAttendees: 50,
      });
      const result = await bookAttendee(event, {
        date: "2026-04-07",
        email: "dnd@test.com",
        name: "Daily NoDate",
      });
      if (!result.success) throw new Error("Failed");

      const { response } = await adminFormPost(
        `/admin/attendees/${result.attendees[0]!.id}/event/${event.id}`,
        { date: "", quantity: "1" },
      );
      expect(response.status).toBe(302);
    });

    test("POST /admin/attendees/:id/event/:eventId handles daily event date", async () => {
      const event = await createTestEvent({
        eventType: "daily",
        maxAttendees: 50,
      });
      const result = await bookAttendee(event, {
        date: "2026-04-07",
        email: "du@test.com",
        name: "Daily Upd",
      });
      if (!result.success) throw new Error("Failed");

      const { response } = await adminFormPost(
        `/admin/attendees/${result.attendees[0]!.id}/event/${event.id}`,
        { date: "2026-04-08", quantity: "1" },
      );
      expect(response.status).toBe(302);
    });

    test("POST /admin/attendees/:id/event/:eventId treats invalid quantity as 1", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 10,
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Qty",
        "qty@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/event/${event.id}`,
        { quantity: "abc" },
      );
      expect(response.status).toBe(302);

      const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
      const raw = await getAttendeesRaw(event.id);
      expect(raw[0]!.quantity).toBe(1);
    });
  });

  describe("GET /admin/attendees/:attendeeId/merge", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockRequest(`/admin/attendees/${attendee.id}/merge`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent attendee", async () => {
      const response = await awaitTestRequest("/admin/attendees/999/merge", {
        cookie: await testCookie(),
      });
      expect(response.status).toBe(404);
    });

    test("shows search form without token param", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}/merge`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Merge Attendee",
        "Search by Ticket Token",
      );
    });

    test("shows error when token not found", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}/merge?token=invalid-token`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "not found");
    });

    test("shows error when token matches same attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee, token } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}/merge?token=${encodeURIComponent(
          token,
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Cannot merge an attendee with themselves",
      );
    });

    test("shows merge preview when valid source token provided", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event.id,
        "John Smith",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Merge Preview",
        "Jane Doe",
        "John Smith",
        "Merge and Delete Source Attendee",
      );
    });
  });

  /** Extract merge_version from the merge preview HTML page */
  const getMergeVersion = async (
    targetId: number,
    sourceToken: string,
  ): Promise<string> => {
    const page = await awaitTestRequest(
      `/admin/attendees/${targetId}/merge?token=${encodeURIComponent(
        sourceToken,
      )}`,
      { cookie: await testCookie() },
    );
    const html = await page.text();
    const value = extractInputValue(html, "merge_version");
    if (value === null) throw new Error("merge_version not found in page");
    return value;
  };

  describe("POST /admin/attendees/:attendeeId/merge", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const response = await handleRequest(
        mockFormRequest(`/admin/attendees/${attendee.id}/merge`, {
          source_token: "some-token",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent target attendee", async () => {
      const { response } = await adminFormPost("/admin/attendees/999/merge", {
        source_token: "some-token",
      });
      expect(response.status).toBe(404);
    });

    test("rejects missing source_token", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        {},
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Source token"), false);
    });

    test("rejects invalid source token", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        { source_token: "nonexistent-token" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("not found"), false);
    });

    test("rejects self-merge", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee, token } = await createTestAttendeeDirect(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/merge`,
        { source_token: token },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Cannot merge an attendee with themselves"),
        false,
      );
    });

    test("merges source events into target and deletes source", async () => {
      const event1 = await createTestEvent({
        maxAttendees: 10,
        name: "Event One",
      });
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "Event Two",
      });

      const { attendee: target } = await createTestAttendeeDirect(
        event1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken, attendee: source } =
        await createTestAttendeeDirect(
          event2.id,
          "John Smith",
          "john@example.com",
        );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        { merge_version: mergeVersion, source_token: sourceToken },
      );

      expectRedirectWithFlash(
        `/admin/attendees/${target.id}`,
        expect.stringContaining("Merged"),
      )(response);

      // Source attendee should be deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      const deleted = await getAttendeeRaw(source.id);
      expect(deleted).toBeNull();

      // Target should still exist
      const surviving = await getAttendeeRaw(target.id);
      expect(surviving).not.toBeNull();

      // Target should now have both event links
      const targetEventLinks = await import("#lib/db/client.ts").then((m) =>
        m.queryAll<{ event_id: number }>(
          "SELECT event_id FROM event_attendees WHERE attendee_id = ?",
          [target.id],
        ),
      );
      const eventIds = targetEventLinks.map((r) => r.event_id).sort();
      expect(eventIds).toEqual([event1.id, event2.id].sort());
    });

    test("keeps target PII when no source fields selected", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "555-1111",
      );
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
        1,
        "555-9999",
      );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      // Submit without choosing source for any field (all default to target)
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        { merge_version: mergeVersion, source_token: sourceToken },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Verify target PII is preserved
      const getPage = await awaitTestRequest(`/admin/attendees/${target.id}`, {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(getPage, 200, "Jane Doe", "jane@example.com");
    });

    test("takes source PII fields when selected", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
        1,
        "555-1234",
        "123 Source St",
        "Source instructions",
      );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      // Choose source for all PII fields
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          pii_address: "source",
          pii_email: "source",
          pii_name: "source",
          pii_phone: "source",
          pii_special_instructions: "source",
          source_token: sourceToken,
        },
      );
      expect(response.status).toBe(302);

      // Verify target now has source's PII
      const getPage = await awaitTestRequest(`/admin/attendees/${target.id}`, {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        getPage,
        200,
        "John Smith",
        "john@example.com",
        "555-1234",
        "123 Source St",
        "Source instructions",
      );
    });

    test("skips conflicting event booking during merge", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      // Both attendees are registered for the same event
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken, attendee: source } =
        await createTestAttendeeDirect(
          event.id,
          "John Smith",
          "john@example.com",
        );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);
      // Booking conflict: same event, same start_at (null) — choose keep_target
      const bookingKey = `${event.id}:null`;
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`booking_${bookingKey}`]: "keep_target",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Source deleted
      const { getAttendeeRaw } = await import("#lib/db/attendees.ts");
      expect(await getAttendeeRaw(source.id)).toBeNull();

      // Target still has exactly one link to the event (conflict was skipped)
      const { queryAll } = await import("#lib/db/client.ts");
      const links = await queryAll<{ event_id: number }>(
        "SELECT event_id FROM event_attendees WHERE attendee_id = ?",
        [target.id],
      );
      expect(links.length).toBe(1);
      expect(links[0]!.event_id).toBe(event.id);
    });
  });

  describe("GET /admin/attendees/:attendeeId/merge (coverage branches)", () => {
    test("shows merge preview with multiline field differences (address differs)", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "",
        "123 Main St",
        "No nuts",
      );
      const event2 = await createTestEvent({ maxAttendees: 10, name: "E2" });
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
        1,
        "",
        "456 Oak Ave",
        "Gluten free",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      // Multiline fields (address, special_instructions) differ — exercises renderFieldValue(val, true) with same=false
      await expectHtmlResponse(response, 200, "456 Oak Ave", "Gluten free");
    });

    test("shows merge preview when source has empty phone but target does not", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "555-1234",
      );
      const event2 = await createTestEvent({ maxAttendees: 10, name: "E2" });
      // Source has no phone — exercises sourceValue || "—" branch
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows merge preview when source and target have empty email", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      // Empty email covers the `email || ""` branches on both target and source
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "",
      );
      const event2 = await createTestEvent({ maxAttendees: 10, name: "E2" });
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "",
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows daily event start_at date in source bookings list", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const dailyEvent = await createTestEvent({
        eventType: "daily",
        maxAttendees: 50,
        name: "Daily E",
      });
      const result = await bookAttendee(dailyEvent, {
        date: "2026-05-01",
        email: "john@example.com",
        name: "John Smith",
      });
      if (!result.success) throw new Error("createAttendeeAtomic failed");
      const sourceToken = result.attendees[0]!.ticket_token;

      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      // start_at is set for daily events — exercises the b.start_at ? `— date` : "" branch
      await expectHtmlResponse(response, 200, "2026-05-01");
    });

    test("shows moveable booking row without decision column when no conflicts", async () => {
      const event1 = await createTestEvent({ maxAttendees: 10 });
      const event2 = await createTestEvent({ maxAttendees: 10, name: "E2" });

      const { attendee: target } = await createTestAttendeeDirect(
        event1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      // All bookings are moveable (different events) — no Decision column rendered
      await expectHtmlResponse(response, 200, "Will be moved");
    });

    test("shows duplicate booking status when same event with identical metadata", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event.id,
        "John Smith",
        "john@example.com",
      );

      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      // Same event, same qty/price/checked_in/refunded — classified as "duplicate"
      await expectHtmlResponse(response, 200, "Duplicate");
    });
  });

  describe("merge with answer conflicts", () => {
    test("GET merge page renders answer decision table when conflicts exist", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const q = await questionsTable.insert({ text: "Favourite colour?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Blue",
      });
      await setEventQuestions(event.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      await setEventQuestions(event2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      // Assign different answers
      const { saveAttendeeAnswers: save } = await import(
        "#lib/db/questions.ts"
      );
      await save([target.id], [a1.id]);
      // Need source attendee ID
      const { getAttendeesByTokens } = await import("#lib/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save([sourceData!.id], [a2.id]);

      const response = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(
        response,
        200,
        "Custom Question Answers",
        "Favourite colour?",
      );
    });

    test("POST merge applies selected answer winners", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const q = await questionsTable.insert({ text: "Size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });
      await setEventQuestions(event.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      await setEventQuestions(event2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#lib/db/questions.ts");
      const { getAttendeesByTokens } = await import("#lib/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save([target.id], [a1.id]); // Small
      await save([sourceData!.id], [a2.id]); // Large

      // Get merge version from preview page
      const previewPage = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      const previewHtml = await previewPage.text();
      const mergeVersion = extractInputValue(previewHtml, "merge_version")!;

      // Submit choosing source answer
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`answer_${q.id}`]: "source",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);

      // Verify target now has source's answer (Large)
      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a2.id);
    });

    test("POST merge reports skipped bookings in flash", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event.id,
        "John Smith",
        "john@example.com",
      );

      // Get merge version
      const previewPage = await awaitTestRequest(
        `/admin/attendees/${target.id}/merge?token=${encodeURIComponent(
          sourceToken,
        )}`,
        { cookie: await testCookie() },
      );
      const html = await previewPage.text();
      const mergeVersion = extractInputValue(html, "merge_version")!;

      const bookingKey = `${event.id}:null`;
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`booking_${bookingKey}`]: "skip_source",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("1 booking(s) skipped"),
        true,
      );
    });

    test("stale preview version rejected", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      // Submit with wrong version — should get validation error (200 response)
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: "stale-version",
          source_token: sourceToken,
        },
      );
      // Validation error renders the merge page (200) with error message
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("out of date");
    });

    test("POST merge with clear answer choice clears the answer", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const q = await questionsTable.insert({ text: "Diet?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Vegan",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Keto",
      });
      await setEventQuestions(event.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      await setEventQuestions(event2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#lib/db/questions.ts");
      const { getAttendeesByTokens } = await import("#lib/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save([target.id], [a1.id]);
      await save([sourceData!.id], [a2.id]);

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`answer_${q.id}`]: "clear",
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.has(q.id)).toBe(false);
    });

    test("POST merge with target answer choice keeps target answer", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const q = await questionsTable.insert({ text: "Shirt?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "M",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "L",
      });
      await setEventQuestions(event.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      await setEventQuestions(event2.id, [q.id]);
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#lib/db/questions.ts");
      const { getAttendeesByTokens } = await import("#lib/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save([target.id], [a1.id]);
      await save([sourceData!.id], [a2.id]);

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`answer_${q.id}`]: "target",
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
    });

    test("POST merge auto-adopts source-only non-conflicting answer", async () => {
      const event1 = await createTestEvent({ maxAttendees: 10 });
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      const q = await questionsTable.insert({ text: "Colour?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Green",
      });
      await setEventQuestions(event1.id, [q.id]);
      await setEventQuestions(event2.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        event1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      // Only source has an answer — no conflict
      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#lib/db/questions.ts");
      const { getAttendeesByTokens } = await import("#lib/db/attendees.ts");
      const [sourceData] = await getAttendeesByTokens([sourceToken]);
      await save([sourceData!.id], [a1.id]);

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
    });

    test("POST merge keeps target-only non-conflicting answer", async () => {
      const event1 = await createTestEvent({ maxAttendees: 10 });
      const event2 = await createTestEvent({
        maxAttendees: 10,
        name: "E2",
      });
      const q = await questionsTable.insert({ text: "Food?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Pizza",
      });
      await setEventQuestions(event1.id, [q.id]);
      await setEventQuestions(event2.id, [q.id]);

      const { attendee: target } = await createTestAttendeeDirect(
        event1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event2.id,
        "John Smith",
        "john@example.com",
      );

      // Only target has an answer — no conflict
      const { saveAttendeeAnswers: save, getAttendeeAnswersByQuestion } =
        await import("#lib/db/questions.ts");
      await save([target.id], [a1.id]);

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
        },
      );
      expect(response.status).toBe(302);

      const finalAnswers = await getAttendeeAnswersByQuestion(target.id);
      expect(finalAnswers.get(q.id)?.answerId).toBe(a1.id);
    });

    test("POST merge with take_source replaces target booking", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const { attendee: target } = await createTestAttendeeDirect(
        event.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        event.id,
        "John Smith",
        "john@example.com",
      );

      const mergeVersion = await getMergeVersion(target.id, sourceToken);

      const bookingKey = `${event.id}:null`;
      const { response } = await adminFormPost(
        `/admin/attendees/${target.id}/merge`,
        {
          merge_version: mergeVersion,
          source_token: sourceToken,
          [`booking_${bookingKey}`]: "take_source",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Merged"), true);
    });
  });
});
