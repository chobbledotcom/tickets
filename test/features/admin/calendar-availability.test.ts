import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  bookDailyTicket,
  fetchCalendarHtml,
  tomorrow,
} from "./calendar-test-helpers.ts";

describeWithEnv(
  "admin calendar availability checker",
  { db: true, env: { NTFY_URL: undefined }, triggers: true },
  () => {
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
