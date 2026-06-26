import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addDays, formatDateLabel } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  awaitTestRequest,
  bookAttendee,
  createDailyTestListing,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirectWithFlash,
  submitTicketForm,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

const tomorrow = () => addDays(todayInTz("UTC"), 1);

async function fetchCalendarHtml(path = "/admin/calendar") {
  const response = await awaitTestRequest(path, {
    cookie: await testCookie(),
  });
  return response.text();
}

async function fetchCalendarResponse(path = "/admin/calendar") {
  return awaitTestRequest(path, { cookie: await testCookie() });
}

async function bookDailyTicket(
  slug: string,
  opts: { name: string; email: string; date: string },
) {
  await submitTicketForm(slug, opts);
}

async function setupDailyBooking(
  date = tomorrow(),
  opts = { email: "a@test.com", name: "User A" },
) {
  const listing = await createDailyTestListing();
  await bookDailyTicket(listing.slug, { ...opts, date });
  return { date, listing };
}

async function setupTwoDailyBookings(date = tomorrow()) {
  const listing1 = await createDailyTestListing();
  const listing2 = await createDailyTestListing();
  await bookDailyTicket(listing1.slug, {
    date,
    email: "a@test.com",
    name: "User A",
  });
  await bookDailyTicket(listing2.slug, {
    date,
    email: "b@test.com",
    name: "User B",
  });
  return { date, listing1, listing2 };
}

async function setupMixedBookings(
  listingDate: string,
  dailyName = "Daily User",
  standardName = "Standard User",
) {
  const dailyListing = await createDailyTestListing();
  const standardListing = await createTestListing({
    date: `${listingDate}T10:00`,
    name: "Workshop",
  });
  await bookDailyTicket(dailyListing.slug, {
    date: listingDate,
    email: `${dailyName.toLowerCase().replace(" ", "")}@test.com`,
    name: dailyName,
  });
  await submitTicketForm(standardListing.slug, {
    email: `${standardName.toLowerCase().replace(" ", "")}@test.com`,
    name: standardName,
  });
  return { dailyListing, listingDate, standardListing };
}

describeWithEnv(
  "admin calendar",
  { db: true, env: { NTFY_URL: undefined }, triggers: true },
  () => {
    describe("GET /admin/calendar", () => {
      testRequiresAuth("/admin/calendar");

      test("renders calendar page when authenticated", async () => {
        const response = await fetchCalendarResponse();
        await expectHtmlResponse(
          response,
          200,
          "Calendar",
          "Attendees by Date",
        );
      });

      test("shows empty dropdown when no daily listings exist", async () => {
        await createTestListing({ name: "Standard Listing" });
        const html = await fetchCalendarHtml();
        expect(html).toContain("Select a date");
      });

      test("shows available dates from daily listings", async () => {
        await createDailyTestListing();
        const html = await fetchCalendarHtml();
        // Should contain at least one date option
        expect(html).toContain("disabled");
      });

      test("includes attendee dates in dropdown", async () => {
        const { date } = await setupDailyBooking();
        const html = await fetchCalendarHtml();
        // The date with a booking should be selectable (not disabled)
        expect(html).toContain(`date=${date}`);
      });

      test("marks every day of a multi-day booking as selectable", async () => {
        const start = tomorrow();
        const secondDay = addDays(start, 1);
        const listing = await createDailyTestListing({ durationDays: 2 });
        await bookAttendee(listing, {
          date: start,
          durationDays: 2,
          email: "a@test.com",
          name: "User A",
        });

        const html = await fetchCalendarHtml();
        // Both the start day and the second day must be selectable links,
        // not disabled options — the booking occupies both days.
        expect(html).toContain(`date=${start}`);
        expect(html).toContain(`date=${secondDay}`);
        expect(html).not.toContain(
          `<option disabled>${formatDateLabel(secondDay)}</option>`,
        );
      });

      test("filters attendees by date parameter", async () => {
        const date1 = addDays(todayInTz("UTC"), 1);
        const date2 = addDays(todayInTz("UTC"), 2);
        const listing = await createDailyTestListing();
        await bookDailyTicket(listing.slug, {
          date: date1,
          email: "a@test.com",
          name: "User A",
        });
        await bookDailyTicket(listing.slug, {
          date: date2,
          email: "b@test.com",
          name: "User B",
        });

        const html = await fetchCalendarHtml(`/admin/calendar?date=${date1}`);
        expect(html).toContain("User A");
        expect(html).not.toContain("User B");
      });

      test("shows attendees from multiple daily listings for same date", async () => {
        const { listing1, listing2, date } = await setupTwoDailyBookings();

        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        expect(html).toContain("User A");
        expect(html).toContain("User B");
        // Both listing names should appear
        expect(html).toContain(listing1.name);
        expect(html).toContain(listing2.name);
      });

      test("links listing name to listing page", async () => {
        const { listing, date } = await setupDailyBooking();

        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        expect(html).toContain(`href="/admin/listing/${listing.id}"`);
      });

      test("shows Export CSV link when attendees exist for date", async () => {
        const { date } = await setupDailyBooking();

        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        expect(html).toContain("Export CSV");
        expect(html).toContain(`/admin/calendar/export?date=${date}`);
      });

      test("does not show Export CSV link when no attendees for date", async () => {
        const validDate = tomorrow();
        await createDailyTestListing();

        const html = await fetchCalendarHtml(
          `/admin/calendar?date=${validDate}`,
        );
        expect(html).not.toContain("Export CSV");
      });

      test("ignores invalid date parameter", async () => {
        const response = await fetchCalendarResponse(
          "/admin/calendar?date=invalid",
        );
        await expectHtmlResponse(
          response,
          200,
          "Select a date above to view attendees",
        );
      });

      test("excludes standard listings without a date from the date picker", async () => {
        await createTestListing({ name: "Standard Listing" });
        const html = await fetchCalendarHtml();
        // A dateless standard listing contributes no selectable date…
        expect(html).not.toContain("?date=");
        // …but it is still bookable, so the availability checker lists it.
        expect(html).toContain("Standard Listing");
      });

      test("shows standard listing date in dropdown", async () => {
        await createTestListing({ date: "2026-06-15T14:00", name: "Concert" });
        const html = await fetchCalendarHtml();
        // Standard listing date appears as a formatted label in the dropdown
        expect(html).toContain("Monday 15 June 2026");
      });

      test("shows standard listing attendees when date is selected", async () => {
        const listing = await createTestListing({
          date: "2026-06-15T14:00",
          name: "Concert",
        });
        await submitTicketForm(listing.slug, {
          email: "fan@test.com",
          name: "Concert Fan",
        });

        const html = await fetchCalendarHtml("/admin/calendar?date=2026-06-15");
        expect(html).toContain("Concert Fan");
        expect(html).toContain("Concert");
      });

      test("does not show standard listing attendees on wrong date", async () => {
        const listing = await createTestListing({
          date: "2026-06-15T14:00",
          name: "Concert",
        });
        await submitTicketForm(listing.slug, {
          email: "fan@test.com",
          name: "Concert Fan",
        });

        const html = await fetchCalendarHtml("/admin/calendar?date=2026-06-16");
        expect(html).not.toContain("Concert Fan");
      });

      test("shows mixed daily and standard listing attendees for same date", async () => {
        const listingDate = addDays(todayInTz("UTC"), 3);
        const { dailyListing } = await setupMixedBookings(listingDate);

        const html = await fetchCalendarHtml(
          `/admin/calendar?date=${listingDate}`,
        );
        expect(html).toContain("Daily User");
        expect(html).toContain("Standard User");
        expect(html).toContain(dailyListing.name);
        expect(html).toContain("Workshop");
      });

      test("marks standard listing date as having bookings when attendees exist", async () => {
        const listing = await createTestListing({
          date: "2026-06-15T14:00",
          name: "Concert",
        });
        await submitTicketForm(listing.slug, {
          email: "fan@test.com",
          name: "Fan",
        });

        const html = await fetchCalendarHtml();
        // Date with bookings should be a clickable link (not disabled)
        expect(html).toContain("date=2026-06-15");
      });

      test("shows multiple standard listings on same date", async () => {
        const listing1 = await createTestListing({
          date: "2026-06-15T10:00",
          name: "Morning Concert",
        });
        const listing2 = await createTestListing({
          date: "2026-06-15T20:00",
          name: "Evening Concert",
        });
        await submitTicketForm(listing1.slug, {
          email: "am@test.com",
          name: "Morning Fan",
        });
        await submitTicketForm(listing2.slug, {
          email: "pm@test.com",
          name: "Evening Fan",
        });

        const html = await fetchCalendarHtml("/admin/calendar?date=2026-06-15");
        expect(html).toContain("Morning Fan");
        expect(html).toContain("Evening Fan");
        expect(html).toContain("Morning Concert");
        expect(html).toContain("Evening Concert");
      });

      test("does not show standard attendees when no standard listings match date", async () => {
        const listing = await createTestListing({
          date: "2026-06-15T14:00",
          name: "Concert",
        });
        await submitTicketForm(listing.slug, {
          email: "fan@test.com",
          name: "Concert Fan",
        });

        // Request a completely different date
        const html = await fetchCalendarHtml("/admin/calendar?date=2026-07-01");
        expect(html).not.toContain("Concert Fan");
      });

      test("standard listing date without attendees shows as disabled", async () => {
        await createTestListing({
          date: "2026-06-15T14:00",
          name: "Empty Listing",
        });

        const html = await fetchCalendarHtml();
        // The date should appear as a disabled option (no bookings)
        expect(html).toContain("<option disabled>Monday 15 June 2026</option>");
      });

      test("renders the calendar grid", async () => {
        const html = await fetchCalendarHtml();
        expect(html).toContain('class="calendar"');
        expect(html).toContain("calendar-grid");
      });

      test("the cal parameter sets the displayed month", async () => {
        const html = await fetchCalendarHtml("/admin/calendar?cal=2027-03");
        expect(html).toMatch(/<option selected[^>]*>March 2027<\/option>/);
      });

      test("invalid cal parameter is ignored", async () => {
        // cal=bogus is rejected, so the month falls back to the selected date.
        const html = await fetchCalendarHtml(
          "/admin/calendar?date=2027-05-15&cal=bogus",
        );
        expect(html).toMatch(/<option selected[^>]*>May 2027<\/option>/);
      });

      test("a booked date is a clickable day link in the grid", async () => {
        const { date } = await setupDailyBooking();
        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        expect(html).toContain(`href="/admin/calendar?date=${date}#attendees"`);
      });

      test("paging months keeps the selected date's attendees", async () => {
        const { date } = await setupDailyBooking();
        // Page to a far-away month while a date is selected; the selection
        // (and its attendees) must survive the month change.
        const html = await fetchCalendarHtml(
          `/admin/calendar?date=${date}&cal=2030-01`,
        );
        expect(html).toContain("User A");
        expect(html).toMatch(/<option selected[^>]*>January 2030<\/option>/);
      });
    });

    describe("GET /admin/calendar/export", () => {
      testRequiresAuth("/admin/calendar/export?date=2026-03-15");

      test("redirects to calendar when no date provided", async () => {
        const response = await fetchCalendarResponse("/admin/calendar/export");
        expectRedirectWithFlash(
          "/admin/calendar",
          "Select a date to export",
          false,
        )(response);
      });

      test("returns CSV with correct headers", async () => {
        const { date } = await setupDailyBooking();

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${date}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "text/csv; charset=utf-8",
        );
        expect(response.headers.get("content-disposition")).toContain(
          "attachment",
        );
        expect(response.headers.get("content-disposition")).toContain(
          `calendar_${date}_attendees.csv`,
        );
      });

      test("includes Listing and Date columns in CSV", async () => {
        const { listing, date } = await setupDailyBooking();

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${date}`,
        );
        const csv = await response.text();
        const lines = csv.split("\n");
        expect(lines[0]).toBe(
          "Listing,Type,Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
        );
        expect(lines[1]).toContain(listing.name);
        expect(lines[1]).toContain(date);
        expect(lines[1]).toContain("User A");
        expect(lines[1]).toContain("Attendee");
      });

      test("includes attendees from multiple listings", async () => {
        const { listing1, listing2 } = await setupTwoDailyBookings();

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${tomorrow()}`,
        );
        const csv = await response.text();
        expect(csv).toContain("User A");
        expect(csv).toContain("User B");
        expect(csv).toContain(listing1.name);
        expect(csv).toContain(listing2.name);
      });

      test("returns empty CSV when no attendees for date", async () => {
        const validDate = tomorrow();
        await createDailyTestListing();

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${validDate}`,
        );
        const csv = await response.text();
        const lines = csv.split("\n");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("Listing,Type,Date,Name");
      });

      test("includes standard listing attendees in CSV export", async () => {
        const listing = await createTestListing({
          date: "2026-06-15T14:00",
          name: "Concert",
        });
        await submitTicketForm(listing.slug, {
          email: "csvfan@test.com",
          name: "CSV Fan",
        });

        const response = await fetchCalendarResponse(
          "/admin/calendar/export?date=2026-06-15",
        );
        const csv = await response.text();
        expect(csv).toContain("Concert");
        expect(csv).toContain("CSV Fan");
      });

      test("includes mixed daily and standard attendees in CSV export", async () => {
        const listingDate = addDays(todayInTz("UTC"), 3);
        const { dailyListing } = await setupMixedBookings(
          listingDate,
          "Daily CSV",
          "Standard CSV",
        );

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${listingDate}`,
        );
        const csv = await response.text();
        expect(csv).toContain("Daily CSV");
        expect(csv).toContain("Standard CSV");
        expect(csv).toContain(dailyListing.name);
        expect(csv).toContain("Workshop");
      });
    });

    describe("availability checker", () => {
      test("lists bookable listings with remaining and a create form", async () => {
        const listing = await createTestListing({
          maxAttendees: 5,
          name: "Avail Listing",
        });
        const html = await fetchCalendarHtml();
        expect(html).toContain("Check availability");
        expect(html).toContain("data-availability-checker");
        expect(html).toContain("Avail Listing");
        expect(html).toContain("5/5");
        expect(html).toContain('action="/admin/attendees/new"');
        expect(html).toContain('formaction="/admin/servicing/new"');
        expect(html).toContain("Create Service Event");
        expect(html).toContain(`name="select_${listing.id}"`);
      });

      test("reflects bookings in the remaining count", async () => {
        await createTestListing({ maxAttendees: 5, name: "Half Full" });
        const listing = await createTestListing({
          maxAttendees: 5,
          name: "Booked Up",
        });
        await bookAttendee(listing, { quantity: 2 });
        const html = await fetchCalendarHtml();
        expect(html).toContain("3/5");
      });

      test("passes the selected calendar date to the create form", async () => {
        const date = tomorrow();
        const listing = await createDailyTestListing({ name: "Daily Avail" });
        await bookDailyTicket(listing.slug, {
          date,
          email: "a@test.com",
          name: "A",
        });
        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        expect(html).toContain('name="start_date"');
        expect(html).toContain(`value="${date}"`);
      });
    });
  },
);
