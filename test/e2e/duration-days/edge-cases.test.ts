import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { checkGroupCapAfterDurationChange } from "#shared/db/attendees/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("e2e: multi-day bookings — edge cases", { db: true }, () => {
  describe("edge cases: realistic unusual scenarios", () => {
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
