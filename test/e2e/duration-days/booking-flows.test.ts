import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { generateAttendeesCsv } from "#routes/admin/attendees-csv.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { checkGroupCapAfterDurationChange } from "#shared/db/attendees/update.ts";
import { describeWithEnv, rawListingRange } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";
import { twoGroupedListingsBookedOnAdjacentDays } from "./helpers.ts";

describeWithEnv("e2e: multi-day bookings — booking flows", { db: true }, () => {
  describe("edge cases", () => {
    test("back-to-back bookings at full capacity do not overlap", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 1,
      });

      // Book days 10–11.
      await bookAttendee(listing, { date: "2026-08-10", durationDays: 2 });

      // Days 12–13 must be bookable (no overlap with 10–11).
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-08-12", 2),
      ).toBe(true);
      // But days 11–12 overlap on day 11.
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-08-11", 2),
      ).toBe(false);
    });

    test("expand-book-shrink cycle keeps all ranges consistent", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 2,
        maximumDaysAfter: 60,
      });

      // Book attendee A on day 1 as 1-day.
      await bookAttendee(listing, { date: "2026-09-01", email: "a@test.com" });

      // Expand to 3-day: A now covers days 1–3.
      await updateTestListing(listing.id, { durationDays: 3 });
      // Day 2 now has A (qty=1), cap=2 → room for 1 more but not 2.
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 2, "2026-09-02"),
      ).toBe(false);
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-09-02"),
      ).toBe(true);

      // Book attendee B on day 1 (room for 1 more since cap=2).
      await bookAttendee(listing, {
        date: "2026-09-01",
        durationDays: 3,
        email: "b@test.com",
      });

      // Now at capacity on days 1–3. Day 4 should still be free.
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-09-04", 3),
      ).toBe(true);
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-09-01", 3),
      ).toBe(false);

      // Shrink back to 1-day: both bookings collapse to day 1 only.
      await updateTestListing(listing.id, { durationDays: 1 });
      // Days 2 and 3 are now free.
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-09-02"),
      ).toBe(true);
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-09-03"),
      ).toBe(true);
      // Day 1 still full (2 bookings, cap 2).
      expect(
        await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-09-01"),
      ).toBe(false);
    });

    test("multi-day booking across a group boundary respects both listing and group caps", async () => {
      const group = await createTestGroup({ maxAttendees: 3 });
      const listingA = await createDailyTestListing({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 10,
      });
      const listingB = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 10,
      });

      // Fill group on day 2 via listingB (3 attendees = group cap).
      await bookAttendee(listingB, { date: "2026-10-02", quantity: 3 });

      // listingA 2-day booking on day 1–2: day 1 is fine, day 2 is
      // group-full. Must reject even though listingA's own cap has room.
      expect(
        await attendeesApi.checkBatchAvailability(
          [{ durationDays: 2, listingId: listingA.id, quantity: 1 }],
          "2026-10-01",
        ),
      ).toBe(false);

      // A 1-day booking on day 1 alone should be fine.
      expect(
        await attendeesApi.checkBatchAvailability(
          [{ durationDays: 1, listingId: listingA.id, quantity: 1 }],
          "2026-10-01",
        ),
      ).toBe(true);
    });
  });

  describe("HTTP layer: admin add attendee", () => {
    test("admin-added attendee on a 3-day listing stores a 3-day range", async () => {
      // This would have caught the bug where buildCreateAttendeeInput
      // omitted durationDays — the booking would silently store a 1-day
      // range regardless of the listing's duration_days setting.
      const { handleRequest } = await import("#routes");
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 5,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            date: "2026-08-10",
            email: "admin-added@example.com",
            name: "Admin Added",
            quantity: "1",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      // Verify the stored range spans 3 days, not 1.
      const range = await rawListingRange(listing.id);
      expect(range).not.toBeNull();
      expect(range!.start_at).toBe("2026-08-10T00:00:00Z");
      expect(range!.end_at).toBe("2026-08-13T00:00:00.000Z");
    });

    test("admin-added attendee respects multi-day capacity", async () => {
      const { handleRequest } = await import("#routes");
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 1,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });

      // Fill day 11 with a 1-day booking.
      await bookAttendee(listing, { date: "2026-08-11", durationDays: 1 });

      // Admin tries to add an attendee starting day 10 (3-day → 10,11,12).
      // Day 11 is full → must reject.
      await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee`,
          {
            csrf_token: csrfToken,
            date: "2026-08-10",
            email: "blocked@example.com",
            name: "Blocked",
            quantity: "1",
          },
          cookie,
        ),
      );
      // Rejected — redirects with error flash, no new attendee.
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });
  });

  describe("CSV export", () => {
    test("date column shows range for multi-day bookings", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
      });
      await bookAttendee(listing, { date: "2026-06-12", durationDays: 3 });
      const attendees = await getAttendeesRaw(listing.id);
      const csv = generateAttendeesCsv(attendees, true);
      expect(csv).toContain("2026-06-12 to 2026-06-14");
    });

    test("date column reflects a customisable booking's chosen span, not the maximum", async () => {
      const listing = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 0, 2: 0, 5: 0 },
        durationDays: 5,
        maxAttendees: 5,
      });
      // The visitor chose 2 days even though the listing's maximum is 5.
      await bookAttendee(listing, { date: "2026-06-12", durationDays: 2 });
      const attendees = await getAttendeesRaw(listing.id);
      const csv = generateAttendeesCsv(attendees, true);
      expect(csv).toContain("2026-06-12 to 2026-06-13");
      // Guard against the *max* span (5 days → ...to 2026-06-16) appearing in
      // the Date column. Check the full range string, not the bare end date —
      // the Registered column is the created-at ISO timestamp, which contains
      // today's date and would otherwise make this assertion fail on 2026-06-16.
      expect(csv).not.toContain("2026-06-12 to 2026-06-16");
    });

    test("date column shows single date for 1-day bookings", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 5 });
      await bookAttendee(listing, { date: "2026-06-12" });
      const attendees = await getAttendeesRaw(listing.id);
      const csv = generateAttendeesCsv(attendees, true);
      expect(csv).toContain("2026-06-12");
      expect(csv).not.toContain("to");
    });
  });

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
