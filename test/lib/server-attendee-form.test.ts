import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
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
  buildAttendeeEditForm,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  getAttendeesRaw,
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
      expect(html).toContain('name="line_listing_id_0"');
      expect(html).toContain('name="line_count" value="1"');
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
      const { listing } = await setupListingAndLogin({
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
            line_listing_id_0: String(listing.id),
            line_quantity_0: "2",
            name: "Jane Doe",
          },
          cookie,
        ),
      );
      expectRedirect(response, "/admin/attendees/");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.quantity).toBe(2);
    });

    test("creates an attendee with multiple listing lines in one submission", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "A",
      });
      const listing2 = await createTestListing({
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
            line_listing_id_0: String(listing1.id),
            line_listing_id_1: String(listing2.id),
            line_quantity_0: "1",
            line_quantity_1: "3",
            name: "Multi",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(listing1.id)).length).toBe(1);
      const att2 = await getAttendeesRaw(listing2.id);
      expect(att2.length).toBe(1);
      expect(att2[0]!.quantity).toBe(3);
    });

    test("re-renders the form without saving when 'Add Listing Line' is clicked", async () => {
      const listing = await createTestListing({
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
            line_listing_id_0: String(listing.id),
            line_quantity_0: "1",
            name: "Preserved",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      // Two lines now, the new one is blank
      expect(html).toContain('name="line_listing_id_1"');
      // Originally entered data is preserved
      expect(html).toContain("Preserved");
      expect(html).toContain("preserve@example.com");
      // No attendee was created
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("re-renders with one fewer line when 'Remove' is clicked", async () => {
      const listing = await createTestListing({
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
            line_listing_id_0: String(listing.id),
            line_listing_id_1: "",
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
      expect(html).not.toContain('name="line_listing_id_1"');
    });

    test("fails validation when name is blank and re-renders with the rest preserved", async () => {
      const listing = await createTestListing({
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
            line_listing_id_0: String(listing.id),
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
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("re-renders preserving entered data when capacity is exceeded", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "First",
        "first@example.com",
      );
      const { response } = await adminFormPost("/admin/attendees/new", {
        email: "second@example.com",
        line_count: "1",
        line_listing_id_0: String(listing.id),
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
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
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
        line_listing_id_0: String(open.id),
        line_listing_id_1: String(full.id),
        line_quantity_0: "1",
        line_quantity_1: "1",
        name: "Multi",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Not enough spots");
      // Nothing committed: the open listing gained no row, the full listing still
      // has only its original filler.
      expect((await getAttendeesRaw(open.id)).length).toBe(0);
      expect((await getAttendeesRaw(full.id)).length).toBe(1);
    });
  });

  describe("POST /admin/attendees/:id — line edits via the unified form", () => {
    test("adds a new listing line to an existing attendee", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "E2",
      });
      const attendee = await createTestAttendee(
        listing1.id,
        listing1.slug,
        "Link",
        "link@example.com",
      );
      // Load the existing line key for listing1
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(attendee.id);
      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [
          {
            date: "",
            key: existing[0]!.key,
            listingId: listing1.id,
            quantity: 1,
          },
          {
            date: "",
            key: "",
            listingId: listing2.id,
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
      expect((await getAttendeesRaw(listing1.id)).length).toBe(1);
      expect((await getAttendeesRaw(listing2.id)).length).toBe(1);
    });

    test("removes an existing listing line via the unified form", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "E1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "E2",
      });
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: listing1.id, quantity: 1 },
          {
            listingId: listing2.id,
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
      const listing1Key = existing.find(
        (e) => e.booking.listing_id === listing1.id,
      )!.key;
      // Submit only listing1 — listing2 should be removed
      const form = await buildAttendeeEditForm(attendeeId, {
        lines: [
          {
            date: "",
            key: listing1Key,
            listingId: listing1.id,
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
      expect((await getAttendeesRaw(listing1.id)).length).toBe(1);
      expect((await getAttendeesRaw(listing2.id)).length).toBe(0);
    });

    test("updates quantity on an existing line via the unified form", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Qty",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Qty",
        "qty@example.com",
      );
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const existing = await loadExistingLines(attendee.id);
      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [
          {
            date: "",
            key: existing[0]!.key,
            listingId: listing.id,
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
      expect((await getAttendeesRaw(listing.id))[0]!.quantity).toBe(4);
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
            line_listing_id_0: String(standard.id),
            line_listing_id_1: String(daily.id),
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
            key: existing[0]!.key,
            listingId: standard.id,
            quantity: 1,
          },
          {
            date: tomorrow,
            key: "",
            listingId: daily.id,
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
        line_listing_id_0: "0",
        name: "No Lines",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Add at least one listing line");
      expect(html).toContain("No Lines");
    });

    test("create re-renders with error when atomic create fails with capacity_exceeded", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
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
            line_listing_id_0: String(listing.id),
            line_quantity_0: "1",
            name: "Cap",
          });
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("spots");
        },
      );
    });

    test("create re-renders with null quantity showing empty value", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        line_count: "1",
        line_listing_id_0: String(listing.id),
        line_quantity_0: "abc",
        name: "Valid",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('value=""');
      expect(html).toContain("Quantity must be at least 1");
    });

    test("create re-renders with line-level error only (no attendee error)", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        line_count: "1",
        line_listing_id_0: String(listing.id),
        line_quantity_0: "5",
        name: "Valid Name",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Quantity must be at most 2");
      expect(html).toContain("Valid Name");
    });

    test("create rejects a malformed email and saves nothing", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        email: "not-an-email",
        line_count: "1",
        line_listing_id_0: String(listing.id),
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
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("edit remove_line drops the line from the form without deleting until save", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
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
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    });

    test("create removing the only new blank line re-renders with a blank line", async () => {
      await createTestListing({ maxAttendees: 100 });
      const { response } = await adminFormPost("/admin/attendees/new", {
        action: "remove_line_0",
        line_count: "1",
        line_listing_id_0: "0",
        name: "",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="line_listing_id_0"');
    });

    test("edit with only blank lines re-renders with no_lines error", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Blank",
        "blank@example.com",
      );
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          action: "save",
          line_count: "1",
          line_listing_id_0: "0",
          name: attendee.name,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Add at least one listing line");
      // The existing booking is untouched (no_lines short-circuits the diff).
      expect((await getAttendeesRaw(listing.id)).length).toBe(1);
    });

    test("edit re-renders preserving data when capacity is exceeded", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
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
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
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
      expect(html).toContain("Edit Attendee: Orphan");
    });

    test("POST edit for attendee with no bookings re-renders with no_lines error", async () => {
      const listing = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
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
          line_listing_id_0: "0",
          name: "Orphan",
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Add at least one listing line");
    });
  });

  describe("custom questions on a multi-listing attendee", () => {
    /** Book an attendee on both listings with a custom question on each, plus an
     * answer to each question. Returns the ids needed to drive an edit. */
    const setupMultiListingQuestions = async () => {
      const listingA = await createTestListing({
        maxAttendees: 10,
        name: "QA Listing",
      });
      const listingB = await createTestListing({
        maxAttendees: 10,
        name: "QB Listing",
      });

      const qA = await questionsTable.insert({ text: "Shirt size?" });
      const aA = await answersTable.insert({
        questionId: qA.id,
        sortOrder: 0,
        text: "Medium",
      });
      await setListingQuestions(listingA.id, [qA.id]);

      const qB = await questionsTable.insert({ text: "Meal choice?" });
      const aB = await answersTable.insert({
        questionId: qB.id,
        sortOrder: 0,
        text: "Vegan",
      });
      await setListingQuestions(listingB.id, [qB.id]);

      const created = await createAttendeeAtomic({
        bookings: [
          { listingId: listingA.id, quantity: 1 },
          { listingId: listingB.id, quantity: 1 },
        ],
        email: "multi@example.com",
        name: "Multi",
      });
      if (!created.success) throw new Error("setup");
      const attendeeId = created.attendees[0]!.id;
      await saveAttendeeAnswers(new Map([[attendeeId, [aA.id, aB.id]]]));
      return { aA, aB, attendeeId, qA, qB };
    };

    test("edit page renders questions from every booked listing", async () => {
      const { attendeeId } = await setupMultiListingQuestions();
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

    test("saving an edit preserves answers for every booked listing", async () => {
      const { aA, aB, attendeeId, qA, qB } = await setupMultiListingQuestions();

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

      // Both answers survive — not just the first listing's.
      const saved = new Set(
        (await getAttendeeAnswersBatch([attendeeId])).get(attendeeId) ?? [],
      );
      expect(saved.has(aA.id)).toBe(true);
      expect(saved.has(aB.id)).toBe(true);
    });

    test("never persists an answer id the admin didn't have as an option", async () => {
      const { aA, attendeeId, qA, qB } = await setupMultiListingQuestions();

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
      const listing = await createTestListing({
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
      await setListingQuestions(listing.id, [q.id]);

      const makeAttendee = async (name: string, email: string) => {
        const result = await createAttendeeAtomic({
          bookings: [{ listingId: listing.id, quantity: 1 }],
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
});
