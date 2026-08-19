import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { checkGroupCapAfterDurationChange } from "#db/attendees/update.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { twoGroupedListingsBookedOnAdjacentDays } from "#test-utils/db-helpers/grouped-days.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("e2e: multi-day bookings — booking flows", { db: true }, () => {
  describe("group cap + duration change interaction", () => {
    test("no-limit group returns null (no cap to violate)", async () => {
      const group = await createTestGroup({ maxAttendees: 0 });
      const listing = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });
      await bookAttendee(listing, { date: "2026-10-01", quantity: 50 });
      expect(
        await checkGroupCapAfterDurationChange(listing.id, group.id),
      ).toBeNull();
    });

    test("checkGroupCapAfterDurationChange returns null when the listing has no bookings", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const listing = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      expect(
        await checkGroupCapAfterDurationChange(listing.id, group.id),
      ).toBeNull();
    });

    test("checkGroupCapAfterDurationChange counts legacy null-start_at attendees via the non-daily clause", async () => {
      // A daily group listing that had attendees added before it was daily
      // (their start_at is NULL). The SQL counts them via `e.listing_type
      // != 'daily'` — but since the listing IS daily, they're excluded from
      // the per-day count and don't spuriously trigger an overflow.
      const group = await createTestGroup({ maxAttendees: 10 });
      const listing = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      // Book normally (has start_at).
      await bookAttendee(listing, { date: "2026-10-01", quantity: 5 });
      // Simulate a legacy attendee with NULL start_at (pre-daily migration).
      const { getDb } = await import("#db/client.ts");
      const { attendeesApi } = await import("#db/attendees/api.ts");
      const legacy = await attendeesApi.createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 5 }],
        email: "legacy@example.com",
        name: "Legacy",
      });
      if (!legacy.success) throw new Error("setup");
      // Wipe start_at to simulate a pre-migration attendee.
      await getDb().execute({
        args: [legacy.attendees[0]!.id, listing.id],
        sql: "UPDATE listing_attendees SET start_at = NULL, end_at = NULL WHERE attendee_id = ? AND listing_id = ?",
      });
      // The null-start_at row is excluded from per-day counts because the
      // listing IS daily — no overflow on day 1 (5 only, not 10).
      expect(
        await checkGroupCapAfterDurationChange(listing.id, group.id),
      ).toBeNull();
    });

    /**
     * The direct partner of the story
     * `@case:stay-length.shared-limit-warning`: the story proves what the
     * organiser is shown; this owns the function-level contract — the exact
     * over-limit day the check reports — which a Cucumber journey may never
     * be the only cover of.
     */
    test("checkGroupCapAfterDurationChange detects overflow", async () => {
      // Two listings in a group with cap 10, each booked for 6 places on its
      // own day. Extending listing A's stay to span listing B's day pushes
      // that day to 12 — over the limit.
      const { group, listingA } = await twoGroupedListingsBookedOnAdjacentDays({
        cap: 10,
        dateA: "2026-10-01",
        dateB: "2026-10-02",
        quantity: 6,
      });

      // Before extending: no overlap, group fine.
      expect(
        await checkGroupCapAfterDurationChange(listingA.id, group.id),
      ).toBeNull();

      // Extend listing A to 2 days → A now spans day 1+2. Day 2 has
      // A(6) + B(6) = 12 > group cap 10.
      await updateTestListing(listingA.id, { durationDays: 2 });
      const overDay = await checkGroupCapAfterDurationChange(
        listingA.id,
        group.id,
      );
      expect(overDay).toBe("2026-10-02");
    });
  });
});
