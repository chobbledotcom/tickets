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
import { getDb } from "#shared/db/client.ts";
import {
  getContactRecord,
  hashEmail,
  saveContactRecord,
  toContactHashParam,
} from "#shared/db/contact-preferences.ts";
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
  createDailyTestListing,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectListingRowQuantity,
  expectRedirect,
  getAttendeesRaw,
  getTestPrivateKey,
  hasSelectedOption,
  mockFormRequest,
  setupListingAndLogin,
  testCookie,
  testRequiresAuth,
  withMocks,
} from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

describeWithEnv("server (unified attendee form)", { db: true }, () => {
  describe("GET /admin/attendees/new", () => {
    testRequiresAuth("/admin/attendees/new");

    test("renders the create form with a quantity box per listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Pick Me",
      });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Add new attendee",
        "Listing Registrations",
        "Create Attendee",
        "Pick Me",
      );
      // A quantity box per listing, and no add-line button (fixed table).
      expect(html).toContain(`name="qty_${listing.id}"`);
      expect(html).not.toContain("Add Listing Line");
    });

    test("hides the date fields when there are no daily listings", async () => {
      // The shared date range only affects daily listings, so a site with only
      // standard (fixed-date) listings never sees the Dates section.
      await createTestListing({ maxAttendees: 100, name: "Standard Only" });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(response, 200);
      expect(html).not.toContain('name="start_date"');
      expect(html).not.toContain('id="day_count"');
      expect(html).not.toContain("only affects daily listings");
    });

    test("shows the optional date fields when a daily listing exists", async () => {
      await createDailyTestListing({ name: "Daily One" });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain('name="start_date"');
      expect(html).toContain('id="day_count"');
      // The note makes clear the date is optional and daily-only.
      expect(html).toContain("only affects daily listings");
    });

    test("omits the 'Back without saving' link", async () => {
      // The browser back button is enough; the explicit link was removed.
      await createTestListing({ maxAttendees: 100, name: "Pick Me" });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(response, 200);
      expect(html).not.toContain("Back without saving");
    });

    test("shows the availability notice on a dateless create form", async () => {
      await createDailyTestListing({ name: "L" });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(
        response,
        200,
        "Availability is inaccurate until dates have been saved",
      );
      // Visible (not hidden) when no date is known.
      expect(html).toContain("data-availability-notice>");
    });

    test("hides the availability notice when a date is pre-filled", async () => {
      const listing = await createDailyTestListing({ name: "D" });
      const response = await awaitTestRequest(
        `/admin/attendees/new?select_${listing.id}=1&start_date=2026-07-01`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("data-availability-notice hidden>");
    });

    test("pre-fills listings selected from the calendar checker", async () => {
      const a = await createTestListing({ maxAttendees: 100, name: "Kayak" });
      const b = await createTestListing({ maxAttendees: 100, name: "Canoe" });
      const response = await awaitTestRequest(
        `/admin/attendees/new?select_${a.id}=1&select_${b.id}=1`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      // Both chosen listings start at quantity 1.
      expect(html).toMatch(new RegExp(`name="qty_${a.id}"[^>]*value="1"`));
      expect(html).toMatch(new RegExp(`name="qty_${b.id}"[^>]*value="1"`));
    });

    test("omits the 'Show all listings' toggle on a bare create form", async () => {
      // Nothing is booked yet, so an un-ticked toggle would hide every row.
      // Instead the form drops the toggle and shows every listing.
      await createTestListing({ maxAttendees: 100, name: "Pick Me" });
      const response = await awaitTestRequest("/admin/attendees/new", {
        cookie: await testCookie(),
      });
      const html = await expectHtmlResponse(response, 200);
      expect(html).not.toContain("Show all listings");
      expect(html).not.toContain('name="show_all"');
      // The editor carries the show-all modifier so the not-booked rows stay
      // visible despite the CSS that hides them under the toggle.
      expect(html).toContain("listing-editor show-all-listings");
    });

    test("keeps the un-ticked 'Show all listings' toggle when listings are pre-filled", async () => {
      // A calendar deep link pre-selects a listing; the other rows stay tucked
      // behind the toggle, which starts un-ticked.
      const picked = await createTestListing({
        maxAttendees: 100,
        name: "Kayak",
      });
      await createTestListing({ maxAttendees: 100, name: "Canoe" });
      const response = await awaitTestRequest(
        `/admin/attendees/new?select_${picked.id}=1`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200, "Show all listings");
      expect(html).toContain('name="show_all"');
      // Un-ticked: the checkbox carries no `checked` attribute.
      expect(html).not.toMatch(/name="show_all"[^>]*checked/);
      expect(html).not.toContain("listing-editor show-all-listings");
    });

    test("pre-fills the shared start date from the deep link", async () => {
      const listing = await createDailyTestListing({ name: "Daily Pick" });
      const response = await awaitTestRequest(
        `/admin/attendees/new?select_${listing.id}=1&start_date=2026-07-01`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toMatch(
        new RegExp(`name="qty_${listing.id}"[^>]*value="1"`),
      );
      expect(html).toContain('value="2026-07-01"');
    });

    test("leaves the start date blank when the deep link omits it", async () => {
      const listing = await createDailyTestListing({ name: "No Date Daily" });
      const response = await awaitTestRequest(
        `/admin/attendees/new?select_${listing.id}=1`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toMatch(
        new RegExp(`name="qty_${listing.id}"[^>]*value="1"`),
      );
      expect(html).toMatch(/name="start_date"[^>]*value=""/);
    });

    test("falls back to all-zero quantities when no selection resolves", async () => {
      const listing = await createTestListing({ maxAttendees: 100, name: "Z" });
      const response = await awaitTestRequest(
        "/admin/attendees/new?select_999999=1",
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toMatch(
        new RegExp(`name="qty_${listing.id}"[^>]*value="0"`),
      );
    });

    test("seeds the shared length from an existing multi-day booking", async () => {
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
      // The shared day-count select preselects the booking's current 2-day span.
      expect(html).toContain('id="day_count"');
      expect(hasSelectedOption(html, "2")).toBe(true);
    });

    test("keeps the 'Show all listings' toggle on the edit form", async () => {
      // An existing attendee always has a booked line, so the toggle stays to
      // tuck the not-booked rows away — the show-all modifier is not applied.
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Booked",
      });
      const result = await bookAttendee(listing);
      const attendeeId = result.success ? result.attendees[0]!.id : 0;
      const response = await awaitTestRequest(
        `/admin/attendees/${attendeeId}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200, "Show all listings");
      expect(html).toContain('name="show_all"');
      expect(html).not.toContain("listing-editor show-all-listings");
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
      const { cookie, csrfToken } = await (
        await import("#test-utils")
      ).getTestSession();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            email: "jane@example.com",
            name: "Jane Doe",
            [`qty_${event.id}`]: "2",
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
      const { cookie, csrfToken } = await (
        await import("#test-utils")
      ).getTestSession();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            email: "multi@example.com",
            name: "Multi",
            [`qty_${event1.id}`]: "1",
            [`qty_${event2.id}`]: "3",
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

    test("fails validation when name is blank and re-renders with the rest preserved", async () => {
      const event = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { cookie, csrfToken } = await (
        await import("#test-utils")
      ).getTestSession();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            email: "preserve@example.com",
            name: "",
            [`qty_${event.id}`]: "1",
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

    test("create books the open listing and overbooks the full one", async () => {
      const open = await createTestListing({ maxAttendees: 100, name: "Open" });
      const full = await createTestListing({ maxAttendees: 1, name: "Full" });
      await createTestAttendee(
        full.id,
        full.slug,
        "Filler",
        "filler@example.com",
      );
      const { response } = await adminFormPost("/admin/attendees/new", {
        name: "Multi",
        [`qty_${open.id}`]: "1",
        [`qty_${full.id}`]: "1",
      });
      // Admin manual add is allowed to overbook, so both bookings are created.
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(open.id)).length).toBe(1);
      expect((await getAttendeesRaw(full.id)).length).toBe(2);
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
          { eventId: event1.id, key: existing[0]!.key, quantity: 1 },
          { eventId: event2.id, key: "", quantity: 1 },
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
        lines: [{ eventId: event1.id, key: event1Key, quantity: 1 }],
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
        lines: [{ eventId: event.id, key: existing[0]!.key, quantity: 4 }],
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

  describe("bookings summary on the edit page", () => {
    test("lists each booked listing with its quantity and a total", async () => {
      const kayak = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Kayak Trip",
      });
      const canoe = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Canoe Trip",
      });
      const created = await createAttendeeAtomic({
        bookings: [
          { listingId: kayak.id, quantity: 2 },
          { listingId: canoe.id, quantity: 3 },
        ],
        email: "booker@example.com",
        name: "Booker",
      });
      if (!created.success) throw new Error("setup");
      const attendeeId = created.attendees[0]!.id;

      const response = await awaitTestRequest(
        `/admin/attendees/${attendeeId}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(
        response,
        200,
        "Bookings",
        "Kayak Trip",
        "Canoe Trip",
      );
      // Each listing's own row shows its quantity (Kayak→2, Canoe→3), so a
      // swapped grouping fails here, not just a wrong sum...
      expectListingRowQuantity(html, kayak.id, 2);
      expectListingRowQuantity(html, canoe.id, 3);
      // ...and the summary footer totals them (2 + 3 = 5).
      expect(html).toContain("<td>5</td>");
    });

    test("surfaces the checked-in status of a booking", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Tour",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Arrived",
        "arrived@example.com",
      );
      const { updateCheckedIn } = await import("#shared/db/attendees.ts");
      await updateCheckedIn(attendee.id, listing.id, true);

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200, "Bookings");
      // Assert the rendered badge markup, not just the words "Checked in",
      // so a mutant that drops the badge styling/element is still caught.
      expect(html).toContain('<span class="badge">Checked in</span>');
    });
  });

  describe("ledger panel on the edit page", () => {
    test("embeds the attendee's running-balance statement with counterparties", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Pottery Class",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ledger Lou",
        "lou@example.com",
      );
      // A fully-paid sale posts the attendee↔revenue and external→attendee legs,
      // so the embedded statement has a sale leg whose counterparty is the
      // listing and a payment leg whose counterparty is the card/bank singleton.
      await postListingSale({
        attendeeId: attendee.id,
        gross: 2500,
        listingId: listing.id,
      });
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      // The shared statement renders inside its own Ledger fieldset.
      expect(html).toContain("<legend>Ledger</legend>");
      expect(html).toContain("<th>Counterparty</th>");
      // The sale's counterparty links to the listing; the payment's is card/bank.
      expect(html).toContain("Pottery Class");
      expect(html).toContain("Card / bank");
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
      expect(html).toContain("different start dates or lengths");
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
      expect(html).not.toContain("different start dates or lengths");
    });
  });

  describe("over-duration warnings", () => {
    test("warns when the range is longer than a daily listing allows", async () => {
      const oneDay = await createDailyTestListing({
        durationDays: 1,
        name: "One Day",
      });
      const twoDay = await createDailyTestListing({
        durationDays: 2,
        name: "Two Day",
      });
      const result = await createAttendeeAtomic({
        bookings: [
          { date: "2026-05-01", durationDays: 3, listingId: oneDay.id },
          { date: "2026-05-01", durationDays: 3, listingId: twoDay.id },
        ],
        email: "",
        name: "Over",
      });
      const attendeeId = result.success ? result.attendees[0]!.id : 0;
      const response = await awaitTestRequest(
        `/admin/attendees/${attendeeId}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      // Per-listing warnings (singular + plural) and a top-of-page summary.
      expect(html).toContain(
        "One Day is designed for up to 1 day, but the booking spans 3.",
      );
      expect(html).toContain(
        "Two Day is designed for up to 2 days, but the booking spans 3.",
      );
      expect(html).toContain("Please double-check");
    });

    test("no warning when the range fits the listing's duration", async () => {
      const daily = await createDailyTestListing({
        durationDays: 3,
        name: "Three Day",
      });
      const result = await bookAttendee(daily, {
        date: "2026-05-01",
        durationDays: 3,
      });
      const attendeeId = result.success ? result.attendees[0]!.id : 0;
      const response = await awaitTestRequest(
        `/admin/attendees/${attendeeId}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).not.toContain("Please double-check");
    });
  });

  describe("admin overbooking", () => {
    test("create may overbook a full listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 1,
        name: "Tiny",
      });
      await createTestAttendee(listing.id, listing.slug, "First", "f@e.com");
      // Capacity is 1 and already full; the admin adds a second anyway.
      const { response } = await adminFormPost("/admin/attendees/new", {
        name: "Second",
        [`qty_${listing.id}`]: "1",
      });
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(listing.id)).length).toBe(2);
    });

    test("edit may overbook by raising the quantity past capacity", async () => {
      const listing = await createTestListing({
        maxAttendees: 2,
        maxQuantity: 10,
        name: "Cap2",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "A",
        "a@e.com",
      );
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const key = (await loadExistingLines(attendee.id))[0]!.key;
      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [{ eventId: listing.id, key, quantity: 10 }],
        name: "A",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(listing.id))[0]!.quantity).toBe(10);
    });

    test("edit may overbook by adding a full listing", async () => {
      const home = await createTestListing({ maxAttendees: 100, name: "Home" });
      const full = await createTestListing({ maxAttendees: 1, name: "Full" });
      await createTestAttendee(full.id, full.slug, "Filler", "fill@e.com");
      const attendee = await createTestAttendee(
        home.id,
        home.slug,
        "B",
        "b@e.com",
      );
      const { loadExistingLines } = await import("#shared/db/attendees.ts");
      const homeKey = (await loadExistingLines(attendee.id))[0]!.key;
      const form = await buildAttendeeEditForm(attendee.id, {
        lines: [
          { eventId: home.id, key: homeKey, quantity: 1 },
          { eventId: full.id, quantity: 1 },
        ],
        name: "B",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);
      expect((await getAttendeesRaw(full.id)).length).toBe(2);
    });

    test("warns on the form when a booking overbooks a listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 1,
        name: "Solo",
      });
      await createTestAttendee(listing.id, listing.slug, "First", "f1@e.com");
      // Blank name forces an in-place re-render that surfaces the warning.
      const { response } = await adminFormPost("/admin/attendees/new", {
        name: "",
        [`qty_${listing.id}`]: "1",
      });
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain("Solo is overbooked");
    });

    test("does not warn when an at-capacity booking is edited unchanged", async () => {
      const listing = await createTestListing({
        maxAttendees: 1,
        name: "Exact",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Only",
        "only@e.com",
      );
      // The booking fills the listing, but it is the attendee's own row — the
      // self-excluding check means no overbooking warning.
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).not.toContain("is overbooked");
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
      const { cookie, csrfToken } = await (
        await import("#test-utils")
      ).getTestSession();
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const { settings } = await import("#shared/db/settings.ts");
      const tomorrow = addDays(todayInTz(settings.timezone), 1);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/attendees/new",
          {
            csrf_token: csrfToken,
            day_count: "1",
            email: "mix@example.com",
            name: "Mix",
            start_date: tomorrow,
            [`qty_${standard.id}`]: "1",
            [`qty_${daily.id}`]: "2",
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
          { eventId: standard.id, key: existing[0]!.key, quantity: 1 },
          { eventId: daily.id, key: "", quantity: 2 },
        ],
        name: "Edit Mix",
        startDate: tomorrow,
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
        name: "No Lines",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Book at least one listing");
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
            name: "Cap",
            [`qty_${event.id}`]: "1",
          });
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("spots");
        },
      );
    });

    test("treats a non-numeric quantity as not booked", async () => {
      const event = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        name: "Valid",
        [`qty_${event.id}`]: "abc",
      });
      // "abc" parses to no quantity, so nothing is booked.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Book at least one listing");
      expect((await getAttendeesRaw(event.id)).length).toBe(0);
    });

    test("create re-renders with line-level error only (no attendee error)", async () => {
      const event = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 2,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        name: "Valid Name",
        [`qty_${event.id}`]: "5",
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
        name: "Valid Name",
        [`qty_${event.id}`]: "1",
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

    test("create requires a start date for a booked daily listing", async () => {
      const daily = await createDailyTestListing({ name: "Daily Needs Date" });
      const { response } = await adminFormPost("/admin/attendees/new", {
        name: "Dateless",
        [`qty_${daily.id}`]: "1",
      });
      // The shared start date is missing, so the daily booking can't be saved.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("A start date is required");
      expect((await getAttendeesRaw(daily.id)).length).toBe(0);
    });

    test("edit that un-books every listing re-renders with the no-lines error", async () => {
      const event = await createTestListing({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Blank",
        "blank@example.com",
      );
      // Set the only booked listing to quantity 0 — nothing remains booked.
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        {
          name: attendee.name,
          [`qty_${event.id}`]: "0",
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Book at least one listing");
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
        { name: "Orphan" },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Book at least one listing");
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

      const qA = await questionsTable.insert({
        displayType: "radio",
        text: "Shirt size?",
      });
      const aA = await answersTable.insert({
        questionId: qA.id,
        sortOrder: 0,
        text: "Medium",
      });
      await setListingQuestions(eventA.id, [qA.id]);

      const qB = await questionsTable.insert({
        displayType: "radio",
        text: "Meal choice?",
      });
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
        (await getAttendeeAnswersBatch([attendeeId], { texts: false })).get(
          attendeeId,
        ) ?? [],
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
        (await getAttendeeAnswersBatch([attendeeId], { texts: false })).get(
          attendeeId,
        ) ?? [],
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
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
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

      const bobAnswers =
        (await getAttendeeAnswersBatch([bob], { texts: false })).get(bob) ?? [];
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
      // Both amount paid and outstanding balance project from the ledger now:
      // post the gross sale (deposit + owed) and the deposit payment, so the
      // attendee has paid `pricePaid` and owes `remainingBalance` in the ledger.
      const gross = pricePaid + remainingBalance;
      if (gross > 0) {
        await postListingSale({
          amountPaid: pricePaid,
          attendeeId: created.attendees[0]!.id,
          gross,
          listingId: listing.id,
        });
      }
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

    test("the outstanding-balance field warns that edits post to the money ledger", async () => {
      // Decision 14: changing the balance now posts a writeoff correction to the
      // source-of-truth ledger, so the field carries a prominent warning.
      const id = await seedAttendee(null, 0);
      const html = await getEdit(id);
      expect(html).toContain("correcting entry to the money ledger");
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

  // The attendee form writes booking stats but must never write contact notes
  // (those are edited only on /admin/history). These guard the persisted
  // contact_preferences side effects through a real form POST — the layer where
  // the original blob bugs (leaked/overwritten notes, uncounted bookings) lived.
  describe("contact_preferences side effects", () => {
    const seededRecord = (adminNotes: string) => ({
      adminBookingCount: 0,
      adminNotes,
      contactCount: 0,
      lastContact: "",
      lastSubject: "",
      publicBookingCount: 0,
      visits: 0,
    });

    test("admin create records an admin booking against the email contact", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const { response } = await adminFormPost("/admin/attendees/new", {
        email: "newbuyer@example.com",
        name: "New Buyer",
        [`qty_${listing.id}`]: "1",
      });
      expect(response.status).toBe(302);
      const record = await getContactRecord(
        await hashEmail("newbuyer@example.com"),
        await getTestPrivateKey(),
      );
      // Counted as an admin booking, never an online one.
      expect(record.adminBookingCount).toBe(1);
      expect(record.publicBookingCount).toBe(0);
    });

    test("creating a second attendee with an existing email keeps that contact's note", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const pk = await getTestPrivateKey();
      const hash = await hashEmail("repeat@example.com");
      // The contact already carries an operator note from a prior interaction.
      await saveContactRecord(hash, seededRecord("Existing VIP note"));

      const { response } = await adminFormPost("/admin/attendees/new", {
        email: "repeat@example.com",
        name: "Repeat Customer",
        [`qty_${listing.id}`]: "1",
      });
      expect(response.status).toBe(302);

      const record = await getContactRecord(hash, pk);
      // The blank form does NOT clobber the stored note (the old create bug)...
      expect(record.adminNotes).toBe("Existing VIP note");
      // ...while the booking is still counted.
      expect(record.adminBookingCount).toBe(1);
    });

    test("changing an attendee's email on edit never copies the note onto the new email", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const pk = await getTestPrivateKey();
      const aliceHash = await hashEmail("alice@example.com");
      const bobHash = await hashEmail("bob@example.com");
      // Alice's contact carries a private note; the attendee starts as Alice.
      await saveContactRecord(aliceHash, seededRecord("Alice private note"));
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@example.com",
      );

      // Switch the attendee's email to Bob and save the form.
      const form = await buildAttendeeEditForm(attendee.id, {
        email: "bob@example.com",
        name: "Alice",
      });
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}`,
        form,
      );
      expect(response.status).toBe(302);

      // Bob's contact must NOT inherit Alice's note (the old leak bug)...
      expect((await getContactRecord(bobHash, pk)).adminNotes).toBe("");
      // ...and Alice's own note is left intact.
      expect((await getContactRecord(aliceHash, pk)).adminNotes).toBe(
        "Alice private note",
      );
    });

    test("keeps the repair link when a contact's stats_blob is corrupt", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Corrupt Contact",
        "corrupt@example.com",
      );
      const hash = await hashEmail("corrupt@example.com");
      // Leave this contact's encrypted stats unreadable — the exact state the
      // best-effort SMS write path can persist — but keep recent activity so
      // the request's prune doesn't delete the row before it is read.
      await getDb().execute({
        args: [hash, Date.now()],
        sql: `INSERT INTO contact_preferences (contact_hash, stats_blob, last_activity) VALUES (?, 'corrupt-blob', ?)
              ON CONFLICT(contact_hash) DO UPDATE SET stats_blob = 'corrupt-blob', last_activity = excluded.last_activity`,
      });

      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie: await testCookie() },
      );
      // The page renders AND keeps the /admin/history repair link for the bad
      // row — dropping the channel would hide the only way to fix it.
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        `/admin/history/${toContactHashParam(hash)}`,
      );
    });
  });
});
