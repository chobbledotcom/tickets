import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import {
  attendeeStatusesTable,
  getPaidDefaultStatus,
} from "#shared/db/attendee-statuses.ts";
import { getAttendeeBalanceState } from "#shared/db/attendees/balance.ts";
import { attendeesApi, createAttendeeAtomic } from "#shared/db/attendees.ts";
import {
  answersTable,
  getAttendeeAnswersBatch,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  adminFormPost,
  awaitTestRequest,
  bookAttendee,
  buildAttendeeEditForm,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  getAttendeesRaw,
  hasSelectedOption,
  mockFormRequest,
  setupListingAndLogin,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";

describeWithEnv("server (unified attendee form)", { db: true }, () => {
  describe("GET /admin/attendees/new", () => {
    testRequiresAuth("/admin/attendees/new");

    test("renders the empty create form with one blank line", async () => {
      await createTestListing({ maxAttendees: 100, name: "Pick Me" });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Add Attendee",
        "Listing Registrations",
        "Create Attendee",
        "Add Listing Line",
        "Pick Me",
      );
      // One blank line is rendered
      expect(html).toContain('name="line_event_id_0"');
      expect(html).toContain('name="line_count" type="hidden" value="1"');
    });

    test("offers a day-count selector for a customisable daily booking", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0, 3: 0 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 50,
      });
      const result = await bookAttendee(listing, {
        date: "2026-09-10",
        durationDays: 2,
      });
      const attendeeId = result.success ? result.attendees[0]!.id : 0;

      const response = await awaitTestRequest(
        `/admin/attendees/${attendeeId}`,
        { cookie: await testCookie() },
      );
      const html = await response.text();
      expect(html).toContain('name="line_day_count_0"');
      expect(html).toContain("Number of days");
      // The booking's current 2-day span is preselected.
      expect(hasSelectedOption(html, "2")).toBe(true);
    });

    test("preserves return_url as a hidden field when provided", async () => {
      await createTestListing({ maxAttendees: 100 });
      const returnUrl = "/admin/calendar";
      const response = await awaitTestRequest(
        `/admin/attendees/new?return_url=${encodeURIComponent(returnUrl)}`,
        { cookie: await testCookie() },
      );
      await expectHtmlResponse(response, 200, 'name="return_url"', returnUrl);
    });
  });

  describe("edit route (/admin/attendees/:id) requires auth", () => {
    // The edit GET/POST share the same session guards as /new. Assert them on
    // the edit endpoints directly so an unauthenticated request can never reach
    // (or mutate) an existing attendee. Auth is checked before the attendee is
    // loaded, so a placeholder id is fine.
    testRequiresAuth("/admin/attendees/1");
    testRequiresAuth("/admin/attendees/1", {
      body: { line_count: "1", name: "X" },
      method: "POST",
    });
  });

  describe("POST /admin/attendees/new", () => {
    testRequiresAuth("/admin/attendees/new", {
      body: { line_count: "1", name: "X" },
      method: "POST",
      setup: async () => {
        await createTestListing({ maxAttendees: 100 });
      },
    });

    test("creates an attendee with one listing line", async () => {
      const { listing: event } = await setupListingAndLogin({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { cookie, csrfToken } = await import("#test-utils").then((m) =>
        m.getTestSession(),
      );
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

    test("creates an attendee with multiple listing lines in one submission", async () => {
      const event1 = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "A",
      });
      const event2 = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "B",
      });
      const { cookie, csrfToken } = await import("#test-utils").then((m) =>
        m.getTestSession(),
      );
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

    test("re-renders the form without saving when 'Add Listing Line' is clicked", async () => {
      const event = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { cookie, csrfToken } = await import("#test-utils").then((m) =>
        m.getTestSession(),
      );
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
      const event = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { cookie, csrfToken } = await import("#test-utils").then((m) =>
        m.getTestSession(),
      );
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
      const event = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { cookie, csrfToken } = await import("#test-utils").then((m) =>
        m.getTestSession(),
      );
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

    test("re-renders preserving entered data when capacity is exceeded", async () => {
      const event = await createTestListing({ maxAttendees: 1 });
      await createTestAttendee(
        event.id,
        event.slug,
        "First",
        "first@example.com",
      );
      const { response } = await adminFormPost("/admin/attendees/new", {
        email: "second@example.com",
        line_count: "1",
        line_event_id_0: String(event.id),
        line_quantity_0: "1",
        name: "Second",
      });
      // In-place re-render (not a redirect) so the operator keeps their input.
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Not enough spots");
      expect(html).toContain("second@example.com");
      expect(html).toContain("Second");
      // All-or-nothing: no second attendee was created (only "First" remains).
      expect((await getAttendeesRaw(event.id)).length).toBe(1);
    });

    test("create rolls back entirely when one of several lines is full", async () => {
      const open = await createTestListing({ maxAttendees: 100, name: "Open" });
      const full = await createTestListing({ maxAttendees: 1, name: "Full" });
      await createTestAttendee(
        full.id,
        full.slug,
        "Filler",
        "filler@example.com",
      );
      const { response } = await adminFormPost("/admin/attendees/new", {
        line_count: "2",
        line_event_id_0: String(open.id),
        line_event_id_1: String(full.id),
        line_quantity_0: "1",
        line_quantity_1: "1",
        name: "Multi",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Not enough spots");
      // Nothing committed: the open event gained no row, the full event still
      // has only its original filler.
      expect((await getAttendeesRaw(open.id)).length).toBe(0);
      expect((await getAttendeesRaw(full.id)).length).toBe(1);
    });
  });

  describe("POST /admin/attendees/:id — line edits via the unified form", () => {
    test("adds a new listing line to an existing attendee", async () => {
      const event1 = await createTestListing({ maxAttendees: 50, name: "E1" });
      const event2 = await createTestListing({ maxAttendees: 50, name: "E2" });
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

    test("removes an existing listing line via the unified form", async () => {
      const event1 = await createTestListing({ maxAttendees: 50, name: "E1" });
      const event2 = await createTestListing({ maxAttendees: 50, name: "E2" });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: event1.id, quantity: 1 },
          {
            listingId: event2.id,
            quantity: 1,
          },
        ],
        email: "",
        name: "Multi",
      });
      if (!result.success) throw new Error("setup");
      const attendeeId = result.attendees[0]!.id;
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(attendeeId);
      const event1Key = existing.find(
        (e) => e.booking.listing_id === event1.id,
      )!.key;
      // Submit only event1 — event2 should be removed
      const form = await buildAttendeeEditForm(attendeeId, {
        lines: [
          {
            date: "",
            eventId: event1.id,
            key: event1Key,
            quantity: 1,
          },
        ],
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
      const event = await createTestListing({
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
        lines: [
          {
            date: "",
            eventId: event.id,
            key: existing[0]!.key,
            quantity: 4,
          },
        ],
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
      const daily = await createTestListing({
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
        listingType: "daily",
        maxAttendees: 50,
        name: "Mixed Daily",
      });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      // Book two distinct dates for the same attendee — both daily, different start dates.
      const result = await createAttendeeAtomic({
        bookings: [
          { date: "2026-06-15", listingId: daily.id, quantity: 1 },
          { date: "2026-06-20", listingId: daily.id, quantity: 1 },
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
      const daily = await createTestListing({
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
        listingType: "daily",
        maxAttendees: 50,
        name: "Uniform Daily",
      });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const result = await createAttendeeAtomic({
        bookings: [{ date: "2026-06-15", listingId: daily.id, quantity: 1 }],
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
      const standard = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Standard Ev",
      });
      const daily = await createTestListing({
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
        listingType: "daily",
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Daily Ev",
      });
      const { cookie, csrfToken } = await import("#test-utils").then((m) =>
        m.getTestSession(),
      );
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
      const standard = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Std Ev",
      });
      const daily = await createTestListing({
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
        listingType: "daily",
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
    test("create re-renders with an error when no listing line is filled in", async () => {
      await createTestListing({ maxAttendees: 100 });
      const { response } = await adminFormPost("/admin/attendees/new", {
        line_count: "1",
        line_event_id_0: "0",
        name: "No Lines",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Add at least one listing line");
      expect(html).toContain("No Lines");
    });

    test("create re-renders with error when atomic create fails with capacity_exceeded", async () => {
      const event = await createTestListing({ maxAttendees: 100 });
      await withMocks(
        () =>
          stub(attendeesApi, "createAttendeeAtomic", () =>
            Promise.resolve({
              reason: "capacity_exceeded" as const,
              success: false,
            }),
          ),
        async () => {
          const { response } = await adminFormPost("/admin/attendees/new", {
            line_count: "1",
            line_event_id_0: String(event.id),
            line_quantity_0: "1",
            name: "Cap",
          });
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("spots");
        },
      );
    });

    test("create re-renders with null quantity showing empty value", async () => {
      const event = await createTestListing({
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
      const event = await createTestListing({
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

    test("create rejects a malformed email and saves nothing", async () => {
      const event = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        email: "not-an-email",
        line_count: "1",
        line_event_id_0: String(event.id),
        line_quantity_0: "1",
        name: "Valid Name",
      });
      // Re-renders in place (200) with the field error; the browser's
      // type=email guard is bypassed by a no-JS / crafted POST, so the server
      // is the only thing standing between bad data and the PII blob.
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Please enter a valid email address");
      expect(html).toContain("Valid Name");
      expect((await getAttendeesRaw(event.id)).length).toBe(0);
    });

    test("edit remove_line drops the line from the form without deleting until save", async () => {
      const event = await createTestListing({ maxAttendees: 100 });
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
      // Removal is now a pure form-state edit — re-render, no DB write. The
      // booking is only deleted when the operator saves.
      expect(response.status).toBe(200);
      expect((await getAttendeesRaw(event.id)).length).toBe(1);
    });

    test("create removing the only new blank line re-renders with a blank line", async () => {
      await createTestListing({ maxAttendees: 100 });
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

    test("edit with only blank lines re-renders with no_lines error", async () => {
      const event = await createTestListing({ maxAttendees: 100 });
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
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Add at least one listing line");
      // The existing booking is untouched (no_lines short-circuits the diff).
      expect((await getAttendeesRaw(event.id)).length).toBe(1);
    });

    test("edit re-renders preserving data when capacity is exceeded", async () => {
      const event = await createTestListing({ maxAttendees: 100 });
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
              reason: "capacity_exceeded" as const,
              success: false,
            }),
          ),
        async () => {
          const form = await buildAttendeeEditForm(attendee.id, {
            name: "Cap Edited",
          });
          const { response } = await adminFormPost(
            `/admin/attendees/${attendee.id}`,
            form,
          );
          // Re-render in place (200), keeping the operator's edits, with a
          // page-level explanation that nothing was saved.
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("nothing was saved");
          expect(html).toContain("Cap Edited");
        },
      );
    });

    test("GET edit page for attendee with no bookings renders with no questions", async () => {
      const event = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Orphan",
        "orphan@example.com",
      );
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      const db = getDbFn();
      await db.execute("DELETE FROM listing_attendees WHERE attendee_id = ?", [
        attendee.id,
      ]);
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Attendee: Orphan");
    });

    test("POST edit for attendee with no bookings re-renders with no_lines error", async () => {
      const event = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Orphan",
        "orphan@example.com",
      );
      const { getDb: getDbFn } = await import("#shared/db/client.ts");
      const db = getDbFn();
      await db.execute("DELETE FROM listing_attendees WHERE attendee_id = ?", [
        attendee.id,
      ]);
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          action: "save",
          line_count: "1",
          line_event_id_0: "0",
          name: "Orphan",
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Add at least one listing line");
    });
  });

  describe("custom questions on a multi-event attendee", () => {
    /** Book an attendee on both events with a custom question on each, plus an
     * answer to each question. Returns the ids needed to drive an edit. */
    const setupMultiEventQuestions = async () => {
      const eventA = await createTestListing({
        maxAttendees: 10,
        name: "QA Event",
      });
      const eventB = await createTestListing({
        maxAttendees: 10,
        name: "QB Event",
      });

      const qA = await questionsTable.insert({ text: "Shirt size?" });
      const aA = await answersTable.insert({
        questionId: qA.id,
        sortOrder: 0,
        text: "Medium",
      });
      await setListingQuestions(eventA.id, [qA.id]);

      const qB = await questionsTable.insert({ text: "Meal choice?" });
      const aB = await answersTable.insert({
        questionId: qB.id,
        sortOrder: 0,
        text: "Vegan",
      });
      await setListingQuestions(eventB.id, [qB.id]);

      const created = await createAttendeeAtomic({
        bookings: [
          { listingId: eventA.id, quantity: 1 },
          { listingId: eventB.id, quantity: 1 },
        ],
        email: "multi@example.com",
        name: "Multi",
      });
      if (!created.success) throw new Error("setup");
      const attendeeId = created.attendees[0]!.id;
      await saveAttendeeAnswers(new Map([[attendeeId, [aA.id, aB.id]]]));
      return { aA, aB, attendeeId, qA, qB };
    };

    test("edit page renders questions from every booked event", async () => {
      const { attendeeId } = await setupMultiEventQuestions();
      const response = await awaitTestRequest(
        `/admin/attendees/${attendeeId}`,
        {
          cookie: await testCookie(),
        },
      );
      const html = await response.text();
      expect(html).toContain("Shirt size?");
      expect(html).toContain("Meal choice?");
    });

    test("saving an edit preserves answers for every booked event", async () => {
      const { aA, aB, attendeeId, qA, qB } = await setupMultiEventQuestions();

      // Submit both answers, as the rendered (pre-checked) form would.
      const form = await buildAttendeeEditForm(attendeeId, {
        extra: {
          [`question_${qA.id}`]: String(aA.id),
          [`question_${qB.id}`]: String(aB.id),
        },
        name: "Multi Edited",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendeeId}`,
        form,
      );
      expect(response.status).toBe(302);

      // Both answers survive — not just the first event's.
      const saved = new Set(
        (await getAttendeeAnswersBatch([attendeeId])).get(attendeeId) ?? [],
      );
      expect(saved.has(aA.id)).toBe(true);
      expect(saved.has(aB.id)).toBe(true);
    });

    test("never persists an answer id the admin didn't have as an option", async () => {
      const { aA, attendeeId, qA, qB } = await setupMultiEventQuestions();

      // Valid answer for qA; a bogus id for qB that isn't one of its options.
      const form = await buildAttendeeEditForm(attendeeId, {
        extra: {
          [`question_${qA.id}`]: String(aA.id),
          [`question_${qB.id}`]: "99999",
        },
        name: "Multi",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendeeId}`,
        form,
      );
      expect(response.status).toBe(302);

      const saved = new Set(
        (await getAttendeeAnswersBatch([attendeeId])).get(attendeeId) ?? [],
      );
      // The bogus id is silently dropped (admin answers are optional), never
      // written — so the form can't inject an arbitrary answer row.
      expect(saved.has(aA.id)).toBe(true);
      expect(saved.has(99999)).toBe(false);
    });

    test("editing one attendee's answers leaves another attendee's untouched", async () => {
      const event = await createTestListing({
        maxAttendees: 10,
        name: "Shared",
      });
      const q = await questionsTable.insert({ text: "Size?" });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "S",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "L",
      });
      await setListingQuestions(event.id, [q.id]);

      const makeAttendee = async (name: string, email: string) => {
        const result = await createAttendeeAtomic({
          bookings: [{ listingId: event.id, quantity: 1 }],
          email,
          name,
        });
        if (!result.success) throw new Error("setup");
        return result.attendees[0]!.id;
      };
      const alice = await makeAttendee("Alice", "alice@example.com");
      const bob = await makeAttendee("Bob", "bob@example.com");
      await saveAttendeeAnswers(new Map([[alice, [a1.id]]]));
      await saveAttendeeAnswers(new Map([[bob, [a2.id]]]));

      // Edit Alice's answer; her save must not touch Bob's row.
      const form = await buildAttendeeEditForm(alice, {
        extra: { [`question_${q.id}`]: String(a2.id) },
        name: "Alice",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${alice}`,
        form,
      );
      expect(response.status).toBe(302);

      const bobAnswers = (await getAttendeeAnswersBatch([bob])).get(bob) ?? [];
      expect(bobAnswers).toEqual([a2.id]);
    });
  });

  describe("status & balance", () => {
    /** Create an attendee with one £10 line, paying `pricePaid` of it. */
    const seedAttendee = async (
      statusId: number | null,
      remainingBalance: number,
      pricePaid = 100,
    ): Promise<number> => {
      const listing = await createTestListing({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      const created = await createAttendeeAtomic({
        bookings: [{ listingId: listing.id, pricePaid, quantity: 1 }],
        email: "r@example.com",
        name: "Reserver",
        remainingBalance,
        statusId,
      });
      if (!created.success) throw new Error("setup failed");
      return created.attendees[0]!.id;
    };

    const newReservation = () =>
      attendeeStatusesTable.insert({
        isReservation: true,
        name: "Reserved",
        reservationAmount: "10%",
      });

    const getEdit = async (id: number): Promise<string> => {
      const response = await awaitTestRequest(`/admin/attendees/${id}`, {
        cookie: await testCookie(),
      });
      return expectHtmlResponse(response, 200, "Status &amp; Balance");
    };

    test("edit persists an updated status and outstanding balance", async () => {
      const reservation = await newReservation();
      const id = await seedAttendee(null, 0);
      const form = await buildAttendeeEditForm(id, {
        extra: {
          remaining_balance: "15.00",
          status_id: String(reservation.id),
        },
        name: "Reserver",
      });
      const { response } = await adminFormPost(`/admin/attendees/${id}`, form);
      expect([302, 303]).toContain(response.status);

      const state = await getAttendeeBalanceState(id);
      expect(state?.statusId).toBe(reservation.id);
      // £15.00 in minor units (GBP).
      expect(state?.remainingBalance).toBe(1500);
    });

    test("edit coerces a blank status back to the public default, not null", async () => {
      // The form offers no "no status" choice, so a blank status_id (only
      // reachable from a hand-crafted POST) must not clear the attendee — it
      // falls back to the public default instead.
      const reservation = await newReservation(); // a second, non-default status
      const publicDefault = await getPaidDefaultStatus(); // the seed is also public default
      const id = await seedAttendee(reservation.id, 1500);
      const form = await buildAttendeeEditForm(id, {
        extra: { remaining_balance: "0", status_id: "" },
        name: "Reserver",
      });
      await adminFormPost(`/admin/attendees/${id}`, form);

      const state = await getAttendeeBalanceState(id);
      expect(state?.statusId).toBe(publicDefault!.id);
      expect(state?.remainingBalance).toBe(0);
    });

    test("edit page warns when a paid status still owes a balance", async () => {
      const paid = await getPaidDefaultStatus();
      const id = await seedAttendee(paid!.id, 1500);
      const html = await getEdit(id);
      expect(html).toContain("paid status but still owes");
    });

    test("edit page warns when a reservation has lost its balance", async () => {
      // £1 deposit paid on the £10 order, but the balance was cleared to £0.
      const reservation = await newReservation();
      const id = await seedAttendee(reservation.id, 0);
      const html = await getEdit(id);
      expect(html).toContain("still unpaid");
    });

    test("edit page nudges to move a fully-paid reservation on", async () => {
      const reservation = await newReservation();
      const id = await seedAttendee(reservation.id, 0, 1000); // paid in full
      const html = await getEdit(id);
      expect(html).toContain("consider moving it to a paid status");
      expect(html).toContain('class="info"');
    });

    test("edit page stays quiet for a reservation that still owes a balance", async () => {
      const reservation = await newReservation();
      const id = await seedAttendee(reservation.id, 900);
      const html = await getEdit(id);
      // Field pre-filled, but no notice — this is the normal mid-reservation state.
      expect(html).toContain('value="9.00"');
      expect(html).not.toContain("still unpaid");
      expect(html).not.toContain("consider moving");
    });

    test("edit page stays quiet when nothing is owed", async () => {
      const id = await seedAttendee(null, 0);
      const html = await getEdit(id);
      expect(html).toContain('name="remaining_balance"');
      expect(html).not.toContain("still unpaid");
      expect(html).not.toContain("paid status but still owes");
    });

    test("edit page shows the attendee's status as a heading when multiple statuses exist", async () => {
      const reservation = await newReservation();
      const id = await seedAttendee(reservation.id, 900);
      const html = await getEdit(id);
      expect(html).toContain("<h2>Status: Reserved</h2>");
    });

    test("edit page status heading reads None when the attendee has no status", async () => {
      await newReservation(); // a second status, so the heading is shown
      const id = await seedAttendee(null, 0);
      const html = await getEdit(id);
      expect(html).toContain("<h2>Status: None</h2>");
    });

    test("edit page omits the status heading when only one status exists", async () => {
      // Fresh installs seed a single status, which carries no information.
      const id = await seedAttendee(null, 0);
      const html = await getEdit(id);
      expect(html).not.toContain("<h2>Status:");
    });

    test("edit page status select offers no 'no status' option", async () => {
      const reservation = await newReservation(); // a second status, so the select is shown
      const id = await seedAttendee(reservation.id, 0);
      const html = await getEdit(id);
      // The empty placeholder choice is gone entirely.
      expect(html).not.toContain("No status");
      // The status select itself has no empty-value option any more.
      expect(html).not.toContain(
        '<select id="status_id" name="status_id"><option selected value="">',
      );
    });

    test("edit page pre-selects the public default when the attendee has no status", async () => {
      await newReservation(); // a second status, so the select is shown
      const defaultStatus = await getPaidDefaultStatus(); // also the public default seed
      const id = await seedAttendee(null, 0); // attendee has no status
      const html = await getEdit(id);
      expect(hasSelectedOption(html, String(defaultStatus!.id))).toBe(true);
    });

    test("edit page submits the lone status as a hidden field (no dropdown)", async () => {
      const only = await getPaidDefaultStatus(); // the single seeded status
      const id = await seedAttendee(only!.id, 0);
      const html = await getEdit(id);
      // No status dropdown is rendered for a single-status site...
      expect(html).not.toContain('<select id="status_id"');
      expect(html).not.toContain("No status");
      // ...but the status is still submitted so a save can't clear it.
      expect(html).toContain(
        `<input name="status_id" type="hidden" value="${only!.id}">`,
      );
    });
  });
});
