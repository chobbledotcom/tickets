import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, queryAll } from "#db/client.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { assignBookingToAgent } from "#test-utils/logistics.ts";
import { featureSetting, withSetting } from "#test-utils/settings.ts";
import {
  setupDailyBooking,
  setupMixedBookings,
  setupTwoDailyBookings,
} from "./calendar/shared.ts";
import {
  bookDailyTicket,
  fetchCalendarHtml,
  fetchCalendarResponse,
  tomorrow,
} from "./calendar-test-helpers.ts";

/** Create the canonical "Concert" standard listing booked by "Concert Fan".
 *  Shared by the "shows attendees when date is selected" and "does not show
 *  attendees on wrong date" tests so they exercise the same fixture and
 *  differ only in the queried date. */
async function setupStandardConcertBooking() {
  const listing = await createTestListing({
    date: "2026-06-15T14:00",
    name: "Concert",
  });
  await submitTicketForm(listing.slug, {
    email: "fan@test.com",
    name: "Concert Fan",
  });
  return listing;
}

describeWithEnv(
  "admin calendar",
  { db: true, env: { NTFY_URL: undefined }, triggers: true },
  () => {
    describe("GET /admin/calendar", () => {
      testRequiresAuth("/admin/calendar");

      test("renders calendar page when authenticated", async () => {
        const response = await fetchCalendarResponse();
        await expectHtmlResponse(response, 200, "Calendar", 'id="attendees"');
      });

      test("shows empty dropdown when no daily listings exist", async () => {
        await createTestListing({ name: "Standard Listing" });
        const html = await fetchCalendarHtml();
        assertStringIncludes(html, "Select a date");
      });

      test("shows available dates from daily listings", async () => {
        await createDailyTestListing();
        const html = await fetchCalendarHtml();
        // Should contain at least one date option
        assertStringIncludes(html, "disabled");
      });

      test("includes attendee dates in dropdown", async () => {
        const { date } = await setupDailyBooking();
        const html = await fetchCalendarHtml();
        // The date with a booking should be selectable (not disabled)
        assertStringIncludes(html, `date=${date}`);
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
        assertStringIncludes(html, `date=${start}`);
        assertStringIncludes(html, `date=${secondDay}`);
        assert(
          !html.includes(
            `<option disabled>${formatDateLabel(secondDay)}</option>`,
          ),
        );
      });

      test("filters attendees by date parameter", async () => {
        const date1 = addDays(testDate(todayInTz("UTC")), 1);
        const date2 = addDays(testDate(todayInTz("UTC")), 2);
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
        assertStringIncludes(html, "User A");
        assert(!html.includes("User B"));
      });

      test("shows attendees from multiple daily listings for same date", async () => {
        const { listing1, listing2, date } = await setupTwoDailyBookings();

        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        assertStringIncludes(html, "User A");
        assertStringIncludes(html, "User B");
        // Both listing names should appear
        assertStringIncludes(html, listing1.name);
        assertStringIncludes(html, listing2.name);
      });

      test("links listing name to listing page", async () => {
        const { listing, date } = await setupDailyBooking();

        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        assertStringIncludes(html, `href="/admin/listing/${listing.id}"`);
      });

      test("shows Export CSV link when attendees exist for date", async () => {
        const { date } = await setupDailyBooking();

        const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
        assertStringIncludes(html, "Export CSV");
        assertStringIncludes(html, `/admin/calendar/export?date=${date}`);
      });

      test("does not show Export CSV link when no attendees for date", async () => {
        const validDate = tomorrow();
        await createDailyTestListing();

        const html = await fetchCalendarHtml(
          `/admin/calendar?date=${validDate}`,
        );
        assert(!html.includes("Export CSV"));
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
        assert(!html.includes("?date="));
        // …but it is still bookable, so the availability checker lists it.
        assertStringIncludes(html, "Standard Listing");
      });

      test("shows standard listing date in dropdown", async () => {
        await createTestListing({ date: "2026-06-15T14:00", name: "Concert" });
        const html = await fetchCalendarHtml();
        // Standard listing date appears as a formatted label in the dropdown
        assertStringIncludes(html, "Monday 15 June 2026");
      });

      test("shows standard listing attendees when date is selected", async () => {
        await setupStandardConcertBooking();

        const html = await fetchCalendarHtml("/admin/calendar?date=2026-06-15");
        assertStringIncludes(html, "Concert Fan");
        assertStringIncludes(html, "Concert");
      });

      test("does not show standard listing attendees on wrong date", async () => {
        await setupStandardConcertBooking();

        const html = await fetchCalendarHtml("/admin/calendar?date=2026-06-16");
        assert(!html.includes("Concert Fan"));
      });

      test("shows mixed daily and standard listing attendees for same date", async () => {
        const listingDate = addDays(testDate(todayInTz("UTC")), 3);
        const { dailyListing } = await setupMixedBookings(listingDate);

        const html = await fetchCalendarHtml(
          `/admin/calendar?date=${listingDate}`,
        );
        assertStringIncludes(html, "Daily User");
        assertStringIncludes(html, "Standard User");
        assertStringIncludes(html, dailyListing.name);
        assertStringIncludes(html, "Workshop");
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
        assertStringIncludes(html, "date=2026-06-15");
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
        assertStringIncludes(html, "Morning Fan");
        assertStringIncludes(html, "Evening Fan");
        assertStringIncludes(html, "Morning Concert");
        assertStringIncludes(html, "Evening Concert");
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
        assert(!html.includes("Concert Fan"));
      });

      test("standard listing date without attendees shows as disabled", async () => {
        await createTestListing({
          date: "2026-06-15T14:00",
          name: "Empty Listing",
        });

        const html = await fetchCalendarHtml();
        // The date should appear as a disabled option (no bookings)
        assertStringIncludes(
          html,
          "<option disabled>Monday 15 June 2026</option>",
        );
      });

      test("renders the calendar grid", async () => {
        const html = await fetchCalendarHtml();
        assertStringIncludes(html, 'class="calendar"');
        assertStringIncludes(html, "calendar-grid");
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
        assertStringIncludes(
          html,
          `href="/admin/calendar?date=${date}#attendees"`,
        );
      });

      test("paging months keeps the selected date's attendees", async () => {
        const { date } = await setupDailyBooking();
        // Page to a far-away month while a date is selected; the selection
        // (and its attendees) must survive the month change.
        const html = await fetchCalendarHtml(
          `/admin/calendar?date=${date}&cal=2030-01`,
        );
        assertStringIncludes(html, "User A");
        expect(html).toMatch(/<option selected[^>]*>January 2030<\/option>/);
      });

      test("does not show cancelled (no-quantity) standard bookings", async () => {
        const listing = await createTestListing({
          date: "2026-06-15T14:00",
          name: "Concert",
        });
        await submitTicketForm(listing.slug, {
          email: "ghost@test.com",
          name: "Ghost Fan",
        });
        // A cancelled/interested booking is a quantity-0 line: the operational
        // calendar counts real attendees only.
        await getDb().execute({
          args: [listing.id],
          sql: "UPDATE listing_attendees SET quantity = 0 WHERE listing_id = ?",
        });

        const html = await fetchCalendarHtml("/admin/calendar?date=2026-06-15");
        assert(!html.includes("Ghost Fan"));
      });

      test("lists logistics agents in the calendar filter bar", async () => {
        await withSetting(featureSetting("logistics"), async () => {
          await logisticsAgents.table.insert({ name: "Van One" });
          const { date } = await setupDailyBooking();

          const html = await fetchCalendarHtml(`/admin/calendar?date=${date}`);
          assertStringIncludes(html, "Van One");
        });
      });

      test("filters attendees by agent parameter", async () => {
        await withSetting(featureSetting("logistics"), async () => {
          const vanOne = (
            await logisticsAgents.table.insert({ name: "Van One" })
          ).id;
          const vanTwo = (
            await logisticsAgents.table.insert({ name: "Van Two" })
          ).id;
          const { date, listing1, listing2 } = await setupTwoDailyBookings();
          const rows = await queryAll<{
            listing_id: number;
            attendee_id: number;
          }>(
            "SELECT listing_id, attendee_id FROM listing_attendees WHERE listing_id IN (?, ?)",
            [listing1.id, listing2.id],
          );
          await assignBookingToAgent(
            rows.find((row) => row.listing_id === listing1.id)!.attendee_id,
            listing1.id,
            vanOne,
            date,
          );
          await assignBookingToAgent(
            rows.find((row) => row.listing_id === listing2.id)!.attendee_id,
            listing2.id,
            vanTwo,
            date,
          );

          const html = await fetchCalendarHtml(
            `/admin/calendar?date=${date}&agent=${vanOne}`,
          );
          assertStringIncludes(html, "User A");
          // User B's booking belongs to another agent, so it is filtered out.
          assert(!html.includes("User B"));
        });
      });
    });
  },
);
