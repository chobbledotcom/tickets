import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { checkGroupCapAfterDurationChange } from "#shared/db/attendees/update.ts";
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

    test("checkGroupCapAfterDurationChange counts rows of a type-flipped listing on every day", async () => {
      // A sibling listing flipped to standard after booking: its rows count
      // toward the group cap on every day, so day 1 of the daily listing's
      // booking (5 + 6 = 11 > 10) overflows even with no range overlap.
      const group = await createTestGroup({ maxAttendees: 10 });
      const daily = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const sibling = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(daily, { date: "2026-10-01", quantity: 5 });
      await bookAttendee(sibling, { date: "2026-10-20", quantity: 6 });
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute({
        args: [sibling.id],
        sql: "UPDATE listings SET listing_type = 'standard' WHERE id = ?",
      });
      expect(await checkGroupCapAfterDurationChange(daily.id, group.id)).toBe(
        "2026-10-01",
      );
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
      const { getDb } = await import("#shared/db/client.ts");
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
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

    test("checkGroupCapAfterDurationChange detects overflow", async () => {
      // Two listings in a group with cap 10. Each has 5 attendees on
      // separate days. Extending listing A's duration to span listing B's
      // day pushes the group total to 10 — at the limit but not over.
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

    test("duration change that causes group overflow is detectable", async () => {
      // Use updateTestListing (full admin form) to change duration, then
      // verify checkGroupCapAfterDurationChange flags the overflow day.
      const { group, listingA } = await twoGroupedListingsBookedOnAdjacentDays({
        cap: 5,
        dateA: "2026-11-01",
        dateB: "2026-11-02",
        quantity: 3,
      });

      // Extend listingA to 2 days → day 2 has A(3) + B(3) = 6 > cap 5.
      await updateTestListing(listingA.id, { durationDays: 2 });
      const overDay = await checkGroupCapAfterDurationChange(
        listingA.id,
        group.id,
      );
      expect(overDay).toBe("2026-11-02");
    });
  });
});
