import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAvailableDates } from "#shared/dates.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { checkGroupCapAfterDurationChange } from "#shared/db/attendees/update.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { describeWithEnv, rawListingRange } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("e2e: multi-day bookings — edge cases", { db: true }, () => {
  describe("edge cases: realistic unusual scenarios", () => {
    test("2: bookable_days change does not corrupt existing bookings", async () => {
      // Book a 3-day range Mon-Tue-Wed, then admin removes Tuesday from bookable_days.
      // Existing booking stays in the DB. New bookings covering Tuesday are blocked.
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      // Book starting 2026-06-08 (Mon) → covers Mon, Tue, Wed.
      await bookAttendee(listing, { date: "2026-06-08", durationDays: 3 });

      // Admin removes Tuesday from bookable days.
      await updateTestListing(listing.id, {
        bookableDays: [
          "Monday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
      });

      // The old booking still occupies those days in the DB.
      const range = await rawListingRange(listing.id);
      expect(range).not.toBeNull();

      // New bookings starting on Monday should be blocked because the range
      // would include Tuesday (now non-bookable).
      const fresh = (await getListingWithCount(listing.id))!;
      const holidays = await getActiveHolidays();
      const dates = getAvailableDates(fresh, holidays);
      // A start date that would require Tuesday should not appear.
      // 2026-06-08 is Monday → 3-day range hits Tuesday → excluded.
      expect(dates).not.toContain("2026-06-08");
    });

    test("3: duration increase extends booking past maximum_days_after (allowed, existing booking)", async () => {
      // An existing booking was valid when created. Admin extends duration.
      // The stored end_at now extends past the booking window — the system
      // allows this for existing bookings (they were booked in good faith).
      const listing = await createDailyTestListing({
        durationDays: 1,
        maxAttendees: 5,
        maximumDaysAfter: 10,
      });
      // Book on day 9 (within the 10-day window).
      await bookAttendee(listing, { date: "2026-06-09" });
      // Extend to 5 days → end_at is now day 14, past the window.
      await updateTestListing(listing.id, { durationDays: 5 });
      const range = await rawListingRange(listing.id);
      expect(range!.end_at).toBe("2026-06-14T00:00:00.000Z");
      // But no new bookings should be offered on day 9 since the range
      // would extend to day 14, past the window.
      const fresh = (await getListingWithCount(listing.id))!;
      const dates = getAvailableDates(fresh, await getActiveHolidays());
      expect(dates).not.toContain("2026-06-09");
    });

    test("4: concurrent at-capacity multi-day bookings — only one wins", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 1,
      });
      const [a, b] = await Promise.all([
        bookAttendee(listing, {
          date: "2026-06-12",
          durationDays: 2,
          email: "a@test.com",
        }),
        bookAttendee(listing, {
          date: "2026-06-12",
          durationDays: 2,
          email: "b@test.com",
        }),
      ]);
      const winners = [a.success, b.success].filter(Boolean);
      expect(winners.length).toBe(1);
    });

    test("9: listing type switch from standard to daily preserves existing attendees", async () => {
      // Standard listing gets attendees, then admin switches to daily.
      // Existing attendees have null start_at/end_at (no date).
      // They should still count toward total capacity.
      const listing = await createDailyTestListing({
        listingType: "standard",
        maxAttendees: 2,
        maximumDaysAfter: 30,
      });
      await bookAttendee(listing, { quantity: 2 });

      // Switch to daily + duration 2.
      await updateTestListing(listing.id, {
        durationDays: 2,
        listingType: "daily",
      });

      // The 2 existing attendees (no date) should still block capacity.
      // hasAvailableSpots with no date checks total.
      expect(await attendeesApi.hasAvailableSpots(listing.id, 1)).toBe(false);
    });

    test("10: duration longer than booking window yields fewer available dates", async () => {
      // duration=5, maximum_days_after=7. The 5-day range must fit in
      // the 7-day window, so only ~3 start dates are possible. A 1-day
      // listing with the same window would have ~7.
      const long = await createDailyTestListing({
        durationDays: 5,
        maxAttendees: 10,
        maximumDaysAfter: 7,
      });
      const short = await createDailyTestListing({
        durationDays: 1,
        maxAttendees: 10,
        maximumDaysAfter: 7,
      });
      const holidays = await getActiveHolidays();
      const longDates = getAvailableDates(
        (await getListingWithCount(long.id))!,
        holidays,
      );
      const shortDates = getAvailableDates(
        (await getListingWithCount(short.id))!,
        holidays,
      );
      expect(shortDates.length).toBeGreaterThan(longDates.length);
      expect(longDates.length).toBeGreaterThan(0);
    });

    test("checkGroupCapAfterDurationChange sort comparator with equal-start ranges", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const event = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(event, { date: "2026-10-01", quantity: 3 });
      await bookAttendee(event, { date: "2026-10-01", quantity: 4 });
      const result = await checkGroupCapAfterDurationChange(event.id, group.id);
      expect(result).toBeNull();
    });
  });
});
