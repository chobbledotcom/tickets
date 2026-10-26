import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { checkGroupCapAfterDurationChange } from "#db/attendees/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  bookableStartDates,
  createDailyTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("e2e: multi-day bookings — edge cases", { db: true }, () => {
  describe("edge cases: realistic unusual scenarios", () => {
    /**
     * The dated range-capacity SQL settling two simultaneous multi-day inserts.
     * The story `@case:stay.two-customers-race-for-the-last-stay` tells the same
     * race in the customers' terms; this owns the direct contract, because the
     * other concurrency test (`create-attendee-atomic.test.ts`) races an undated
     * standard listing and so never touches the range check.
     */
    test("two simultaneous multi-day bookings for one place — only one is taken", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 1,
      });
      const results = await Promise.all(
        ["a@test.com", "b@test.com"].map((email) =>
          bookAttendee(listing, {
            date: "2026-06-12",
            durationDays: 2,
            email,
          }),
        ),
      );
      expect(results.filter(({ success }) => success).length).toBe(1);
    });

    /**
     * The switch now asks for a day first (see the daily-switch suites and the
     * story `@case:switch-to-daily.assigning-a-day-completes-the-switch`). This
     * keeps the direct capacity contract the issue pinned: the bookings made
     * before the switch take up room on the day the organiser gave them.
     */
    test("a listing flipped to daily counts bookings made before it had dates", async () => {
      const listing = await createDailyTestListing({
        listingType: "standard",
        maxAttendees: 2,
        maximumDaysAfter: 30,
      });
      await bookAttendee(listing, { quantity: 2 });
      const day = (await bookableStartDates(listing.id))[0]!;

      await updateTestListing(listing.id, {
        assignUndatedTo: day,
        durationDays: 2,
        listingType: "daily",
      });

      expect(await attendeesApi.hasAvailableSpots(listing.id, 1, day)).toBe(
        false,
      );
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
