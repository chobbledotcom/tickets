import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, queryAll, queryOne } from "#db/client.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  expectCsvDownloadHeaders,
  expectRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { assignBookingToAgent } from "#test-utils/logistics.ts";
import { featureSetting, withSetting } from "#test-utils/settings.ts";
import {
  bookDailyTicket,
  fetchCalendarResponse,
  tomorrow,
} from "../calendar-test-helpers.ts";
import {
  setupDailyBooking,
  setupMixedBookings,
  setupTwoDailyBookings,
} from "./shared.ts";

describeWithEnv(
  "admin calendar export",
  { db: true, env: { NTFY_URL: undefined }, triggers: true },
  () => {
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
        expectCsvDownloadHeaders(response, `calendar_${date}_attendees.csv`);
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
        assertStringIncludes(lines[1] ?? "", listing.name);
        assertStringIncludes(lines[1] ?? "", date);
        assertStringIncludes(lines[1] ?? "", "User A");
        assertStringIncludes(lines[1] ?? "", "Attendee");
      });

      test("includes attendees from multiple listings", async () => {
        const { listing1, listing2 } = await setupTwoDailyBookings();

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${tomorrow()}`,
        );
        const csv = await response.text();
        assertStringIncludes(csv, "User A");
        assertStringIncludes(csv, "User B");
        assertStringIncludes(csv, listing1.name);
        assertStringIncludes(csv, listing2.name);
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
        assertStringIncludes(lines[0] ?? "", "Listing,Type,Date,Name");
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
        assertStringIncludes(csv, "Concert");
        assertStringIncludes(csv, "CSV Fan");
      });

      test("includes mixed daily and standard attendees in CSV export", async () => {
        const listingDate = addDays(testDate(todayInTz("UTC")), 3);
        const { dailyListing } = await setupMixedBookings(
          listingDate,
          "Daily CSV",
          "Standard CSV",
        );

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${listingDate}`,
        );
        const csv = await response.text();
        assertStringIncludes(csv, "Daily CSV");
        assertStringIncludes(csv, "Standard CSV");
        assertStringIncludes(csv, dailyListing.name);
        assertStringIncludes(csv, "Workshop");
      });

      test("exports newest bookings first", async () => {
        const { date, listing1, listing2 } = await setupTwoDailyBookings();
        // Pin the registration stamps so the expected order is exact no
        // matter how far apart the two bookings land within the test run.
        const rows = await queryAll<{
          listing_id: number;
          attendee_id: number;
        }>(
          "SELECT listing_id, attendee_id FROM listing_attendees WHERE listing_id IN (?, ?)",
          [listing1.id, listing2.id],
        );
        await getDb().execute({
          args: [
            "2020-01-01T00:00:00.000Z",
            rows.find((row) => row.listing_id === listing1.id)!.attendee_id,
          ],
          sql: "UPDATE attendees SET created = ? WHERE id = ?",
        });
        await getDb().execute({
          args: [
            "2021-01-01T00:00:00.000Z",
            rows.find((row) => row.listing_id === listing2.id)!.attendee_id,
          ],
          sql: "UPDATE attendees SET created = ? WHERE id = ?",
        });

        const response = await fetchCalendarResponse(
          `/admin/calendar/export?date=${date}`,
        );
        const lines = (await response.text()).split("\n");
        // User B registered later, so their row leads the export.
        assertStringIncludes(lines[1] ?? "", "User B");
        assertStringIncludes(lines[2] ?? "", "User A");
      });

      test("adds logistics run-sheet columns for logistics bookings", async () => {
        await withSetting(featureSetting("logistics"), async () => {
          const vanOne = (
            await logisticsAgents.table.insert({ name: "Van One" })
          ).id;
          const listing = await createDailyTestListing({
            usesLogistics: true,
          });
          const date = tomorrow();
          await bookDailyTicket(listing.slug, {
            date,
            email: "a@test.com",
            name: "User A",
          });
          const booking = await queryOne<{ attendee_id: number }>(
            "SELECT attendee_id FROM listing_attendees WHERE listing_id = ?",
            [listing.id],
          );
          await assignBookingToAgent(
            booking!.attendee_id,
            listing.id,
            vanOne,
            date,
          );

          const response = await fetchCalendarResponse(
            `/admin/calendar/export?date=${date}`,
          );
          const csv = await response.text();
          assertStringIncludes(csv, "Start Agent");
          assertStringIncludes(csv, "Van One");
        });
      });
    });
  },
);
