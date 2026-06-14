import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeesApi } from "#shared/db/attendees.ts";
import {
  adminFormPost,
  awaitTestRequest,
  buildAttendeeEditForm,
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  getAttendeesRaw,
  mockFormRequest,
  setupEventAndLogin,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

describeWithEnv("server (unified attendee form)", { db: true }, () => {
  describe("GET /admin/attendees/new", () => {
    testRequiresAuth("/admin/attendees/new");

    test("renders the empty create form with one blank line", async () => {
      await createTestEvent({ maxAttendees: 100, name: "Pick Me" });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Add Attendee",
        "Event Registrations",
        "Create Attendee",
        "Add Event Line",
        "Pick Me",
      );
      // One blank line is rendered
      expect(html).toContain('name="line_event_id_0"');
      expect(html).toContain('name="line_count" value="1"');
    });

    test("preserves return_url as a hidden field when provided", async () => {
      await createTestEvent({ maxAttendees: 100 });
      const returnUrl = "/admin/calendar";
      const response = await awaitTestRequest(
        `/admin/attendees/new?return_url=${encodeURIComponent(returnUrl)}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, 'name="return_url"', returnUrl);
    });
  });

  describe("POST /admin/attendees/new", () => {
    testRequiresAuth("/admin/attendees/new", {
      body: { line_count: "1", name: "X" },
      method: "POST",
      setup: async () => {
        await createTestEvent({ maxAttendees: 100 });
      },
    });

    test("creates an attendee with one event line", async () => {
      const { event } = await setupEventAndLogin({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { cookie, csrfToken } = await import("#test-utils")
        .then((m) => m.getTestSession());
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            email: "jane@example.com",
            line_count: "1",
            line_event_id_0: String(event.id),
            line_quantity_0: "2",
            name: "Jane Doe",
          },
          cookie,
        ),
      );
      expectRedirect(response, "/admin/attendees/");
      const attendees = await getAttendeesRaw(event.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.quantity).toBe(2);
    });

    test("creates an attendee with multiple event lines in one submission", async () => {
      const event1 = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "A",
      });
      const event2 = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "B",
      });
      const { cookie, csrfToken } = await import("#test-utils")
        .then((m) => m.getTestSession());
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            email: "multi@example.com",
            line_count: "2",
            line_event_id_0: String(event1.id),
            line_event_id_1: String(event2.id),
            line_quantity_0: "1",
            line_quantity_1: "3",
            name: "Multi",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(event1.id)).length).toBe(1);
      const att2 = await getAttendeesRaw(event2.id);
      expect(att2.length).toBe(1);
      expect(att2[0]!.quantity).toBe(3);
    });

    test("re-renders the form without saving when 'Add Event Line' is clicked", async () => {
      const event = await createTestEvent({ maxAttendees: 100, maxQuantity: 5 });
      const { cookie, csrfToken } = await import("#test-utils")
        .then((m) => m.getTestSession());
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            action: "add_line",
            csrf_token: csrfToken,
            email: "preserve@example.com",
            line_count: "1",
            line_event_id_0: String(event.id),
            line_quantity_0: "1",
            name: "Preserved",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // Two lines now, the new one is blank
      expect(html).toContain('name="line_event_id_1"');
      // Originally entered data is preserved
      expect(html).toContain("Preserved");
      expect(html).toContain("preserve@example.com");
      // No attendee was created
      expect((await getAttendeesRaw(event.id)).length).toBe(0);
    });

    test("re-renders with one fewer line when 'Remove' is clicked", async () => {
      const event = await createTestEvent({ maxAttendees: 100, maxQuantity: 5 });
      const { cookie, csrfToken } = await import("#test-utils")
        .then((m) => m.getTestSession());
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            action: "remove_line_0",
            csrf_token: csrfToken,
            line_count: "2",
            line_event_id_0: String(event.id),
            line_event_id_1: "",
            line_quantity_0: "1",
            line_quantity_1: "1",
            name: "Trim",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // Only one line should remain
      expect(html).not.toContain('name="line_event_id_1"');
    });

    test("fails validation when name is blank and re-renders with the rest preserved", async () => {
      const event = await createTestEvent({ maxAttendees: 100, maxQuantity: 5 });
      const { cookie, csrfToken } = await import("#test-utils")
        .then((m) => m.getTestSession());
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            email: "preserve@example.com",
            line_count: "1",
            line_event_id_0: String(event.id),
            line_quantity_0: "1",
            name: "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Name is required");
      expect(html).toContain("preserve@example.com");
      // No attendee was created
      expect((await getAttendeesRaw(event.id)).length).toBe(0);
    });

    test("redirects with error when capacity is exceeded", async () => {
      const event = await createTestEvent({ maxAttendees: 1 });
      await createTestAttendee(event.id, event.slug, "First", "first@example.com");
      const { response } = await adminFormPost("/admin/attendees/new", {
        email: "second@example.com",
        line_count: "1",
        line_event_id_0: String(event.id),
        line_quantity_0: "1",
        name: "Second",
      });
      expect(response.status).toBe(302);
    });
  });

  describe("POST /admin/attendees/:id — line edits via the unified form", () => {
    test("adds a new event line to an existing attendee", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50, name: "E1" });
      const event2 = await createTestEvent({ maxAttendees: 50, name: "E2" });
      const attendee = await createTestAttendee(
        event1.id,
        event1.slug,
        "Link",
        "link@example.com",
      );
      // Load the existing line key for event1
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(attendee.id);
      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [
          {
            date: "",
            eventId: event1.id,
            key: existing[0]!.key,
            quantity: 1,
          },
          {
            date: "",
            eventId: event2.id,
            key: "",
            quantity: 1,
          },
        ],
        name: "Link",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(event1.id)).length).toBe(1);
      expect((await getAttendeesRaw(event2.id)).length).toBe(1);
    });

    test("removes an existing event line via the unified form", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50, name: "E1" });
      const event2 = await createTestEvent({ maxAttendees: 50, name: "E2" });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const result = await createAttendeeAtomic({
        bookings: [{ eventId: event1.id, quantity: 1 }, {
          eventId: event2.id,
          quantity: 1,
        }],
        email: "",
        name: "Multi",
      });
      if (!result.success) throw new Error("setup");
      const attendeeId = result.attendees[0]!.id;
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(attendeeId);
      const event1Key = existing.find((e) => e.booking.event_id === event1.id)!.key;
      // Submit only event1 — event2 should be removed
      const form = await buildAttendeeEditForm(attendeeId, {
        lines: [{
          date: "",
          eventId: event1.id,
          key: event1Key,
          quantity: 1,
        }],
        name: "Multi",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendeeId}`,
        form,
      );
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(event1.id)).length).toBe(1);
      expect((await getAttendeesRaw(event2.id)).length).toBe(0);
    });

    test("updates quantity on an existing line via the unified form", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Qty",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Qty",
        "qty@example.com",
      );
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(attendee.id);
      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [{
          date: "",
          eventId: event.id,
          key: existing[0]!.key,
          quantity: 4,
        }],
        name: "Qty",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(event.id))[0]!.quantity).toBe(4);
    });
  });

  describe("daily defaults + mixed-timing alert on the edit page", () => {
    test("shows the mixed-timing alert when daily bookings differ in start date", async () => {
      const daily = await createTestEvent({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 50,
        name: "Mixed Daily",
      });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      // Book two distinct dates for the same attendee — both daily, different start dates.
      const result = await createAttendeeAtomic({
        bookings: [
          { date: "2026-06-15", eventId: daily.id, quantity: 1 },
          { date: "2026-06-20", eventId: daily.id, quantity: 1 },
        ],
        email: "",
        name: "Mixed",
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await response.text();
      expect(html).toContain("different start dates or durations");
    });

    test("does not show the mixed-timing alert when daily bookings are uniform", async () => {
      const daily = await createTestEvent({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 50,
        name: "Uniform Daily",
      });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const result = await createAttendeeAtomic({
        bookings: [{ date: "2026-06-15", eventId: daily.id, quantity: 1 }],
        email: "",
        name: "Uniform",
      });
      if (!result.success) throw new Error("setup");
      const attendee = result.attendees[0]!;

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await response.text();
      expect(html).not.toContain("different start dates or durations");
    });
  });

  describe("integration: mixed single-day and multi-day on one attendee", () => {
    test("creates an attendee with both a standard and a daily line", async () => {
      const standard = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Standard Ev",
      });
      const daily = await createTestEvent({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Daily Ev",
      });
      const { cookie, csrfToken } = await import("#test-utils")
        .then((m) => m.getTestSession());
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const { settings } = await import("#shared/db/settings.ts");
      const tomorrow = addDays(todayInTz(settings.timezone), 1);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            email: "mix@example.com",
            line_count: "2",
            line_date_0: "",
            line_date_1: tomorrow,
            line_event_id_0: String(standard.id),
            line_event_id_1: String(daily.id),
            line_quantity_0: "1",
            line_quantity_1: "2",
            name: "Mix",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const stdAttendees = await getAttendeesRaw(standard.id);
      expect(stdAttendees.length).toBe(1);
      expect(stdAttendees[0]!.date).toBeNull();

      const dailyAttendees = await getAttendeesRaw(daily.id);
      expect(dailyAttendees.length).toBe(1);
      expect(dailyAttendees[0]!.date).toBe(tomorrow);
      expect(dailyAttendees[0]!.quantity).toBe(2);
    });

    test("edits an attendee adding a daily line alongside an existing standard one", async () => {
      const standard = await createTestEvent({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Std Ev",
      });
      const daily = await createTestEvent({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Daily Ev",
      });
      const attendee = await createTestAttendee(
        standard.id,
        standard.slug,
        "Edit Mix",
        "editmix@example.com",
      );
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(attendee.id);
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const { settings } = await import("#shared/db/settings.ts");
      const tomorrow = addDays(todayInTz(settings.timezone), 1);

      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [
          {
            date: "",
            eventId: standard.id,
            key: existing[0]!.key,
            quantity: 1,
          },
          {
            date: tomorrow,
            eventId: daily.id,
            key: "",
            quantity: 2,
          },
        ],
        name: "Edit Mix",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);

      const stdAttendees = await getAttendeesRaw(standard.id);
      expect(stdAttendees.length).toBe(1);
      expect(stdAttendees[0]!.date).toBeNull();

      const dailyAttendees = await getAttendeesRaw(daily.id);
      expect(dailyAttendees.length).toBe(1);
      expect(dailyAttendees[0]!.date).toBe(tomorrow);
    });
  });

  describe("error paths and edge cases", () => {
    test("create redirects with error when atomic create fails with encryption_error", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await withMocks(
        () =>
          stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.resolve({
              reason: "encryption_error" as const,
              success: false,
            })
          ),
        async () => {
          const { response } = await adminFormPost("/admin/attendees/new", {
            line_count: "1",
            line_event_id_0: String(event.id),
            line_quantity_0: "1",
            name: "Enc",
          });
          expectRedirect(response, "/admin/attendees/new");
          expectFlash(
            response,
            expect.stringContaining("Encryption"),
            false,
          );
        },
      );
    });

    test("create redirects with error when atomic create fails with capacity_exceeded", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await withMocks(
        () =>
          stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.resolve({
              reason: "capacity_exceeded" as const,
              success: false,
            })
          ),
        async () => {
          const { response } = await adminFormPost("/admin/attendees/new", {
            line_count: "1",
            line_event_id_0: String(event.id),
            line_quantity_0: "1",
            name: "Cap",
          });
          expectRedirect(response, "/admin/attendees/new");
          expectFlash(
            response,
            expect.stringContaining("spots"),
            false,
          );
        },
      );
    });

    test("create re-renders with null quantity showing empty value", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        line_count: "1",
        line_event_id_0: String(event.id),
        line_quantity_0: "abc",
        name: "Valid",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('value=""');
      expect(html).toContain("Quantity must be at least 1");
    });

    test("create re-renders with line-level error only (no attendee error)", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        line_count: "1",
        line_event_id_0: String(event.id),
        line_quantity_0: "5",
        name: "Valid Name",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Quantity must be at most 2");
      expect(html).toContain("Valid Name");
    });

    test("edit removing last existing booking deletes attendee and redirects", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Solo",
        "solo@example.com",
      );
      const form = await buildAttendeeEditForm(attendee.id, {
        name: "Solo",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          ...form,
          action: "remove_line_0",
        },
      );
      expectRedirect(response, "/admin/");
      expectFlash(response, "Attendee removed");
      const remaining = await getAttendeesRaw(event.id);
      expect(remaining.length).toBe(0);
    });

    test("create removing the only new blank line re-renders with a blank line", async () => {
      await createTestEvent({ maxAttendees: 100 });
      const { response } = await adminFormPost("/admin/attendees/new", {
        action: "remove_line_0",
        line_count: "1",
        line_event_id_0: "0",
        name: "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="line_event_id_0"');
    });

    test("edit with only blank lines redirects with no_lines error", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Blank",
        "blank@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          action: "save",
          line_count: "1",
          line_event_id_0: "0",
          name: attendee.name,
        },
      );
      expectRedirect(response, `/admin/attendees/${attendee.id}`);
      expectFlash(
        response,
        "At least one event line is required",
        false,
      );
    });

    test("edit redirects with error when atomic edit fails with capacity_exceeded", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Cap",
        "cap@example.com",
      );
      await withMocks(
        () =>
          stub(attendeesApi, "applyAttendeeAtomicEdit", () =>
            Promise.resolve({
              failingKey: null,
              reason: "capacity_exceeded" as const,
              success: false,
            })
          ),
        async () => {
          const form = await buildAttendeeEditForm(attendee.id, {
            name: "Cap",
          });
          const { response } = await adminFormPost(
            `/admin/attendees/${attendee.id}`,
            form,
          );
          expectRedirect(response, `/admin/attendees/${attendee.id}`);
          expectFlash(response, expect.stringContaining("Capacity lost"), false);
        },
      );
    });

    test("edit redirects with error when atomic edit fails with encryption_error", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Enc",
        "enc@example.com",
      );
      await withMocks(
        () =>
          stub(attendeesApi, "applyAttendeeAtomicEdit", () =>
            Promise.resolve({
              reason: "encryption_error" as const,
              success: false,
            })
          ),
        async () => {
          const form = await buildAttendeeEditForm(attendee.id, {
            name: "Enc",
          });
          const { response } = await adminFormPost(
            `/admin/attendees/${attendee.id}`,
            form,
          );
          expectRedirect(response, `/admin/attendees/${attendee.id}`);
          expectFlash(response, expect.stringContaining("Encryption"), false);
        },
      );
    });
    test("GET edit page for attendee with no bookings renders with no questions", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Orphan",
        "orphan@example.com",
      );
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      const db = getDbFn();
      await db.execute(
        "DELETE FROM event_attendees WHERE attendee_id = ?",
        [attendee.id],
      );
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Edit Attendee: Orphan");
    });

    test("POST edit for attendee with no bookings redirects with no_lines error", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Orphan",
        "orphan@example.com",
      );
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      const db = getDbFn();
      await db.execute(
        "DELETE FROM event_attendees WHERE attendee_id = ?",
        [attendee.id],
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          action: "save",
          line_count: "1",
          line_event_id_0: "0",
          name: "Orphan",
        },
      );
      expectRedirect(response, `/admin/attendees/${attendee.id}`);
      expectFlash(
        response,
        "At least one event line is required",
        false,
      );
    });
  });
});
