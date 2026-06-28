/**
 * End-to-end tests for multi-day bookings (duration_days).
 *
 * These exercise the full stack — creating listings, booking, editing
 * durations, and verifying that availability, stored ranges, group caps,
 * email labels, ticket views, and admin pages all behave correctly as a
 * coherent system. Unit tests under test/lib/db/attendees/ cover each
 * function in isolation; these tests verify the pieces compose.
 */

import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { generateAttendeesCsv } from "#routes/admin/attendees-csv.ts";
import { addDays, getAvailableDates } from "#shared/dates.ts";
import {
  checkBatchAvailability,
  checkGroupCapAfterDurationChange,
  getAttendeesRaw,
  hasAvailableSpots,
} from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getListing, getListingWithCount } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { buildTemplateData } from "#shared/email-renderer.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import {
  adminFormPost,
  apiRequest,
  assertJson,
  awaitTestRequest,
  bookAttendee,
  createDailyTestListing,
  createTestGroup,
  createTestHoliday,
  describeWithEnv,
  expectFlashRedirect,
  getListingActivityLog,
  makeTestEntry,
  mockFormRequest,
  rawListingRange,
  setupListingAndLogin,
  updateTestListing,
} from "#test-utils";

describeWithEnv("e2e: multi-day bookings", { db: true }, () => {
  describe("booking + stored range", () => {
    test("a 3-day booking stores a 3-day range and is visible from all layers", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
      });

      const result = await bookAttendee(listing, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      expect(result.success).toBe(true);

      const range = await rawListingRange(listing.id);
      expect(range).not.toBeNull();
      expect(range!.start_at).toBe("2026-06-12T00:00:00Z");
      expect(range!.end_at).toBe("2026-06-15T00:00:00.000Z");
      expect(range!.quantity).toBe(2);
    });
  });

  describe("per-day capacity", () => {
    test("filling a middle day blocks a multi-day booking that spans it", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 2,
      });

      // Fill day 2 with a 1-day booking at capacity.
      await bookAttendee(listing, {
        date: "2026-06-13",
        durationDays: 1,
        quantity: 2,
      });

      // 3-day booking starting day 1 covers 12–14 → day 13 is full.
      expect(await hasAvailableSpots(listing.id, 1, "2026-06-12", 3)).toBe(
        false,
      );
    });

    test("single day within a blocked multi-day range is still bookable alone", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 2,
      });
      await bookAttendee(listing, {
        date: "2026-06-13",
        durationDays: 1,
        quantity: 2,
      });

      // Day 1 alone (before the full day) is still available.
      expect(await hasAvailableSpots(listing.id, 1, "2026-06-12", 1)).toBe(
        true,
      );
    });

    test("filling a tail day blocks the range but not the head", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 1,
      });
      await bookAttendee(listing, { date: "2026-06-14", durationDays: 1 });

      // 3-day starting 2026-06-12 touches 12,13,14 — day 14 full.
      expect(await hasAvailableSpots(listing.id, 1, "2026-06-12", 3)).toBe(
        false,
      );
      // Days 12 and 13 individually are fine.
      expect(await hasAvailableSpots(listing.id, 1, "2026-06-12", 1)).toBe(
        true,
      );
      expect(await hasAvailableSpots(listing.id, 1, "2026-06-13", 1)).toBe(
        true,
      );
    });
  });

  describe("group per-day capacity", () => {
    test("combo booking fills Saturday group cap across listings", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const sat = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });
      const combo = await createDailyTestListing({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 100,
      });

      // Fill Saturday: 5 via sat-only + 5 via combo (covers Sat+Sun).
      await bookAttendee(sat, { date: "2026-05-02", quantity: 5 });
      await bookAttendee(combo, {
        date: "2026-05-02",
        durationDays: 2,
        quantity: 5,
      });

      // Saturday group-full → 1 more on sat-only must reject.
      expect(
        await checkBatchAvailability(
          [{ listingId: sat.id, quantity: 1 }],
          "2026-05-02",
        ),
      ).toBe(false);
    });

    test("Sunday still has room when only the combo spans both days", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const sat = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });
      const combo = await createDailyTestListing({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 100,
      });
      const sun = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });

      await bookAttendee(sat, { date: "2026-05-02", quantity: 5 });
      await bookAttendee(combo, {
        date: "2026-05-02",
        durationDays: 2,
        quantity: 5,
      });

      // Sunday has 5 from combo only → 5 more fits.
      expect(
        await checkBatchAvailability(
          [{ listingId: sun.id, quantity: 5 }],
          "2026-05-03",
        ),
      ).toBe(true);
    });
  });

  describe("admin duration edit + availability reconciliation", () => {
    test("changing duration updates existing booking ranges and shifts availability", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });

      // Book day 10 as a 1-day booking.
      await bookAttendee(listing, { date: "2026-08-10" });

      // Day 11 is available before the change.
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-11")).toBe(true);

      // Admin changes duration from 1 → 3.
      await updateTestListing(listing.id, { durationDays: 3 });

      // The booking now spans days 10, 11, 12 — verify stored end_at.
      const range = await rawListingRange(listing.id);
      expect(range!.end_at).toBe("2026-08-13T00:00:00.000Z");

      // Day 11 is now occupied by the extended booking.
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-11")).toBe(false);
      // Day 12 is also occupied.
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-12")).toBe(false);
      // Day 13 is free (range is half-open: [10, 13)).
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-13")).toBe(true);

      // Verify the listing metadata also changed.
      const fresh = await getListing(listing.id);
      expect(fresh?.duration_days).toBe(3);
    });

    test("shrinking duration frees previously-occupied days", async () => {
      const listing = await createDailyTestListing({
        durationDays: 5,
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });

      // Book a 5-day range starting day 10 → occupies 10–14.
      await bookAttendee(listing, { date: "2026-08-10", durationDays: 5 });
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-14")).toBe(false);

      // Shrink duration to 2.
      await updateTestListing(listing.id, { durationDays: 2 });

      // Booking now spans 10–11. Days 12–14 are free.
      const range = await rawListingRange(listing.id);
      expect(range!.end_at).toBe("2026-08-12T00:00:00.000Z");
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-12")).toBe(true);
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-14")).toBe(true);
    });

    test("changing duration back to 1 collapses ranges to single-day", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listing, { date: "2026-08-10", durationDays: 3 });

      await updateTestListing(listing.id, { durationDays: 1 });
      const range = await rawListingRange(listing.id);
      expect(range!.end_at).toBe("2026-08-11T00:00:00.000Z");
      // Day 11 is now free.
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-11")).toBe(true);
    });
  });

  describe("available dates filtering", () => {
    test("multi-day range excludes start dates whose tail hits a holiday", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 10,
      });

      // Create a holiday 3 days from now.
      const today = new Date();
      today.setUTCDate(today.getUTCDate() + 3);
      const holidayDate = today.toISOString().slice(0, 10);
      await createTestHoliday({
        endDate: holidayDate,
        name: "Block",
        startDate: holidayDate,
      });
      const holidays = await getActiveHolidays();
      const dates = getAvailableDates(
        (await getListingWithCount(listing.id))!,
        holidays,
      );

      // The holiday itself must not be a start date.
      expect(dates).not.toContain(holidayDate);
      // A start date 2 days before the holiday would have the holiday on
      // its 3rd day — must also be excluded.
      const twoBefore = new Date(today);
      twoBefore.setUTCDate(twoBefore.getUTCDate() - 2);
      const twoBeforeStr = twoBefore.toISOString().slice(0, 10);
      expect(dates).not.toContain(twoBeforeStr);
    });

    test("single-day listing offers more start dates than multi-day for same window", async () => {
      const single = await createDailyTestListing({
        durationDays: 1,
        maxAttendees: 10,
      });
      const multi = await createDailyTestListing({
        durationDays: 5,
        maxAttendees: 10,
      });
      const holidays = await getActiveHolidays();
      const singleDates = getAvailableDates(
        (await getListingWithCount(single.id))!,
        holidays,
      );
      const multiDates = getAvailableDates(
        (await getListingWithCount(multi.id))!,
        holidays,
      );
      // Multi-day has fewer start dates because the tail must fit in the window.
      expect(singleDates.length).toBeGreaterThan(multiDates.length);
    });
  });

  describe("display: email template date_range_label", () => {
    const labelFor = (
      listing: Parameters<typeof makeTestEntry>[0],
      attendee: Parameters<typeof makeTestEntry>[1],
    ) =>
      buildTemplateData(
        [makeTestEntry(listing, attendee)],
        "GBP",
        "https://example.com/t/ABC",
      ).entries[0]!.attendee.date_range_label;

    test("multi-day booking shows en-dash range", () => {
      // The label reflects the booking's stored span (end_date exclusive), so a
      // 3-day booking from the 12th ends (exclusive) on the 15th.
      expect(
        labelFor(
          { duration_days: 3, listing_type: "daily" },
          { date: "2026-06-12", end_date: "2026-06-15" },
        ),
      ).toBe("12\u201314 June 2026");
    });

    test("single-day booking shows full date", () => {
      expect(
        labelFor(
          { duration_days: 1, listing_type: "daily" },
          { date: "2026-06-12" },
        ),
      ).toContain("12 June");
    });

    test("no-date booking shows empty string", () => {
      expect(labelFor({}, { date: null })).toBe("");
    });
  });

  describe("edge cases", () => {
    test("back-to-back bookings at full capacity do not overlap", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 1,
      });

      // Book days 10–11.
      await bookAttendee(listing, { date: "2026-08-10", durationDays: 2 });

      // Days 12–13 must be bookable (no overlap with 10–11).
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-12", 2)).toBe(
        true,
      );
      // But days 11–12 overlap on day 11.
      expect(await hasAvailableSpots(listing.id, 1, "2026-08-11", 2)).toBe(
        false,
      );
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
      expect(await hasAvailableSpots(listing.id, 2, "2026-09-02")).toBe(false);
      expect(await hasAvailableSpots(listing.id, 1, "2026-09-02")).toBe(true);

      // Book attendee B on day 1 (room for 1 more since cap=2).
      await bookAttendee(listing, {
        date: "2026-09-01",
        durationDays: 3,
        email: "b@test.com",
      });

      // Now at capacity on days 1–3. Day 4 should still be free.
      expect(await hasAvailableSpots(listing.id, 1, "2026-09-04", 3)).toBe(
        true,
      );
      expect(await hasAvailableSpots(listing.id, 1, "2026-09-01", 3)).toBe(
        false,
      );

      // Shrink back to 1-day: both bookings collapse to day 1 only.
      await updateTestListing(listing.id, { durationDays: 1 });
      // Days 2 and 3 are now free.
      expect(await hasAvailableSpots(listing.id, 1, "2026-09-02")).toBe(true);
      expect(await hasAvailableSpots(listing.id, 1, "2026-09-03")).toBe(true);
      // Day 1 still full (2 bookings, cap 2).
      expect(await hasAvailableSpots(listing.id, 1, "2026-09-01")).toBe(false);
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
        await checkBatchAvailability(
          [{ durationDays: 2, listingId: listingA.id, quantity: 1 }],
          "2026-10-01",
        ),
      ).toBe(false);

      // A 1-day booking on day 1 alone should be fine.
      expect(
        await checkBatchAvailability(
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
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const legacy = await createAttendeeAtomic({
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
      const group = await createTestGroup({ maxAttendees: 10 });
      const listingA = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const listingB = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listingA, { date: "2026-10-01", quantity: 6 });
      await bookAttendee(listingB, { date: "2026-10-02", quantity: 6 });

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
      const group = await createTestGroup({ maxAttendees: 5 });
      const listingA = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const listingB = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listingA, { date: "2026-11-01", quantity: 3 });
      await bookAttendee(listingB, { date: "2026-11-02", quantity: 3 });

      // Extend listingA to 2 days → day 2 has A(3) + B(3) = 6 > cap 5.
      await updateTestListing(listingA.id, { durationDays: 2 });
      const overDay = await checkGroupCapAfterDurationChange(
        listingA.id,
        group.id,
      );
      expect(overDay).toBe("2026-11-02");
    });
  });

  describe("public ticket page", () => {
    test("shows booking duration hint for multi-day daily listings", async () => {
      const { ticketPage, buildTicketListing } = await import(
        "#templates/public.tsx"
      );
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 10,
      });
      const fresh = (await getListingWithCount(listing.id))!;
      const html = ticketPage({
        dates: ["2026-08-10", "2026-08-11"],
        listings: [buildTicketListing(fresh, false, undefined)],
        slugs: [listing.slug],
      });
      expect(html).toContain("each booking reserves 3 days");
    });

    test("no duration hint for single-day daily listings", async () => {
      const { ticketPage, buildTicketListing } = await import(
        "#templates/public.tsx"
      );
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const fresh = (await getListingWithCount(listing.id))!;
      const html = ticketPage({
        dates: ["2026-08-10"],
        listings: [buildTicketListing(fresh, false, undefined)],
        slugs: [listing.slug],
      });
      expect(html).not.toContain("each booking reserves");
    });
  });

  describe("admin listing detail page", () => {
    test("shows booking duration row for daily listings with duration > 1", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("Booking Duration");
      expect(html).toContain("3 day(s)");
    });

    test("does not show booking duration for standard listings", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("Booking Duration");
    });
  });

  describe("admin listing edit page", () => {
    test("edit form pre-fills duration_days and includes warning UI", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        durationDays: 5,
        listingType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/edit`,
        {
          cookie,
        },
      );
      const html = await response.text();
      // The duration input is pre-filled with the stored value.
      expect(html).toMatch(/name="duration_days"[^>]*value="5"/);
      // Every element initDurationWarning() hooks into must be present —
      // if any of these IDs change, the client-side gate silently no-ops.
      expect(html).toContain('id="listing-edit-form"');
      expect(html).toContain('id="duration-warning"');
      expect(html).toContain('data-duration-original="5"');
      expect(html).toContain('id="duration-warning-confirm"');
      expect(html).toContain('id="listing-edit-submit"');
    });
  });

  describe("admin listing edit POST", () => {
    /** Minimal valid edit form for a daily listing (urlencoded POST). */
    const dailyEditForm = (
      listing: { name: string; slug: string },
      durationDays: number,
      groupId = 0,
    ): Record<string, string> => ({
      duration_days: String(durationDays),
      // Membership is carried by the group_ids checkboxes; only send one when the
      // listing is in a group (0 = ungrouped).
      ...(groupId > 0 ? { group_ids: String(groupId) } : {}),
      listing_type: "daily",
      max_attendees: "100",
      max_quantity: "1",
      name: listing.name,
      slug: listing.slug,
      thank_you_url: "https://example.com",
    });

    test("changing duration via form updates listing and reconciles bookings", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listing, { date: "2026-09-10" });

      await updateTestListing(listing.id, { durationDays: 4 });

      const fresh = await getListing(listing.id);
      expect(fresh?.duration_days).toBe(4);

      const range = await rawListingRange(listing.id);
      expect(range!.end_at).toBe("2026-09-14T00:00:00.000Z");
    });

    test("duration change that overflows the group cap warns in the flash and logs", async () => {
      // Same shape as the checkGroupCapAfterDurationChange unit test, but
      // through the real POST: extending listing A to span listing B's day pushes
      // the group total to 12 > cap 10 on day 2.
      const group = await createTestGroup({ maxAttendees: 10 });
      const listingA = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      const listingB = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listingA, { date: "2026-10-01", quantity: 6 });
      await bookAttendee(listingB, { date: "2026-10-02", quantity: 6 });

      const { response } = await adminFormPost(
        `/admin/listing/${listingA.id}/edit`,
        dailyEditForm(listingA, 2, group.id),
      );
      await expectFlashRedirect(
        `/admin/listing/${listingA.id}`,
        "Listing updated Warning: group capacity exceeded on 2026-10-02",
      )(response);

      const messages = (await getListingActivityLog(listingA.id)).map(
        (l: { message: string }) => l.message,
      );
      expect(messages).toContain(
        `Listing '${listingA.name}' duration changed to 2 day(s)`,
      );
      expect(messages).toContain(
        "Duration change caused group capacity overflow on 2026-10-02",
      );
    });

    test("editing a daily listing without changing duration leaves ranges and log alone", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listing, { date: "2026-09-10", durationDays: 2 });
      const before = await rawListingRange(listing.id);

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        dailyEditForm(listing, 2),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      const after = await rawListingRange(listing.id);
      expect(after!.end_at).toBe(before!.end_at);
      const messages = (await getListingActivityLog(listing.id)).map(
        (l: { message: string }) => l.message,
      );
      expect(messages.some((m: string) => m.includes("duration changed"))).toBe(
        false,
      );
    });

    test("editing a customisable listing's max duration leaves existing booking ranges untouched", async () => {
      const listing = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 5,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      // The visitor chose a 2-day span; that's their booking, not the maximum.
      await bookAttendee(listing, { date: "2026-09-10", durationDays: 2 });
      const before = await rawListingRange(listing.id);

      await updateTestListing(listing.id, { durationDays: 4 });

      const fresh = await getListing(listing.id);
      expect(fresh?.duration_days).toBe(4);
      // The maximum changed, but the existing booking's stored range is intact —
      // customisable bookings are never rewritten from the listing duration.
      const after = await rawListingRange(listing.id);
      expect(after!.end_at).toBe(before!.end_at);
      const messages = (await getListingActivityLog(listing.id)).map(
        (l: { message: string }) => l.message,
      );
      expect(messages.some((m: string) => m.includes("duration changed"))).toBe(
        false,
      );
    });

    test("changing duration on a standard listing does not reconcile or log a duration change", async () => {
      const { listing } = await setupListingAndLogin({ maxAttendees: 100 });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          duration_days: "7",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
          thank_you_url: "https://example.com",
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      // The value persists (inert until the listing becomes daily)…
      expect((await getListing(listing.id))?.duration_days).toBe(7);
      // …but no reconciliation activity is logged for a standard listing.
      const messages = (await getListingActivityLog(listing.id)).map(
        (l: { message: string }) => l.message,
      );
      expect(messages.some((m: string) => m.includes("duration changed"))).toBe(
        false,
      );
    });
  });

  describe("admin REST API", () => {
    test("POST /api/admin/listings creates listing with duration_days", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: 3,
            listing_type: "daily",
            max_attendees: 50,
            name: "API Multi-Day",
          },
          method: "POST",
        }),
        201,
        (body: {
          listing: { duration_days: number; listing_type: string };
        }) => {
          expect(body.listing.duration_days).toBe(3);
          expect(body.listing.listing_type).toBe("daily");
        },
      );
    });

    test("PUT /api/admin/listings/:id updates duration_days", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { duration_days: 7 },
          method: "PUT",
        }),
        200,
        (body: { listing: { duration_days: number } }) => {
          expect(body.listing.duration_days).toBe(7);
        },
      );
    });

    test("PUT /api/admin/listings/:id preserves duration_days when omitted", async () => {
      const listing = await createDailyTestListing({
        durationDays: 5,
        maxAttendees: 10,
      });
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { name: "Renamed" },
          method: "PUT",
        }),
        200,
        (body: { listing: { duration_days: number; name: string } }) => {
          expect(body.listing.name).toBe("Renamed");
          expect(body.listing.duration_days).toBe(5);
        },
      );
    });

    test("POST /api/admin/listings clamps out-of-range duration_days", async () => {
      // The admin form validates 1-90, but the JSON API has no form layer —
      // the column-level clamp must bound it (each day adds a clause to the
      // atomic capacity SQL, so an unbounded value is a perf hazard).
      const high = await assertJson<{
        listing: { id: number; duration_days: number };
      }>(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: 5000,
            listing_type: "daily",
            max_attendees: 50,
            name: "API Clamped High",
          },
          method: "POST",
        }),
        201,
      );
      expect(high.listing.duration_days).toBe(MAX_DURATION_DAYS);
      const stored = await getListing(high.listing.id);
      expect(stored?.duration_days).toBe(MAX_DURATION_DAYS);
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: -2,
            listing_type: "daily",
            max_attendees: 50,
            name: "API Clamped Low",
          },
          method: "POST",
        }),
        201,
        (body: { listing: { duration_days: number } }) => {
          expect(body.listing.duration_days).toBe(1);
        },
      );
    });
  });

  describe("public booking API", () => {
    beforeEach(async () => {
      await settings.update.showPublicApi(true);
    });

    /** Fetch the listing's bookable start dates as the public API reports them. */
    const fetchAvailableDates = async (slug: string): Promise<string[]> => {
      const body = await assertJson<{
        listing: { availableDates: string[] };
      }>(apiRequest(`/api/listings/${slug}`), 200);
      return body.listing.availableDates;
    };

    test("POST /api/listings/:slug/book on a 3-day listing stores a 3-day range", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
      });
      const dates = await fetchAvailableDates(listing.slug);
      expect(dates.length).toBeGreaterThan(0);

      await assertJson(
        apiRequest(`/api/listings/${listing.slug}/book`, {
          body: {
            date: dates[0],
            email: "multi@test.com",
            name: "Multi Day",
          },
          method: "POST",
        }),
        200,
        (body: { booking?: { ticketToken?: string } }) => {
          expect(body.booking?.ticketToken).toBeDefined();
        },
      );

      const range = await rawListingRange(listing.id);
      expect(range!.start_at).toBe(`${dates[0]}T00:00:00Z`);
      const expectedEnd = new Date(
        new Date(`${dates[0]}T00:00:00Z`).getTime() + 3 * 86_400_000,
      ).toISOString();
      expect(range!.end_at).toBe(expectedEnd);
    });

    test("availability and booking reject a start date whose middle day is full", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 2,
      });
      const dates = await fetchAvailableDates(listing.slug);
      const start = dates[0]!;
      const middle = addDays(start, 1);
      await bookAttendee(listing, {
        date: middle,
        durationDays: 1,
        quantity: 2,
      });

      await assertJson(
        apiRequest(
          `/api/listings/${listing.slug}/availability?date=${start}&quantity=1`,
        ),
        200,
        (body: { available: boolean }) => {
          expect(body.available).toBe(false);
        },
      );

      await assertJson(
        apiRequest(`/api/listings/${listing.slug}/book`, {
          body: { date: start, email: "blocked@test.com", name: "Blocked" },
          method: "POST",
        }),
        409,
      );
    });
  });

  describe("admin CSV export via HTTP", () => {
    test("GET /admin/listing/:id/export includes date range for multi-day", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      await bookAttendee(listing, { date: "2026-06-12", durationDays: 3 });

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).toContain("2026-06-12 to 2026-06-14");
    });
  });

  describe("admin attendee detail page", () => {
    test("shows date range for multi-day booking in listing links table", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 10,
      });
      const result = await bookAttendee(listing, {
        date: "2026-07-15",
        durationDays: 3,
      });
      if (!result.success) throw new Error("setup");

      const { cookie } = await setupListingAndLogin();
      const response = await awaitTestRequest(
        `/admin/attendees/${result.attendees[0]!.id}`,
        { cookie },
      );
      const html = await response.text();
      // Should show the range label, not just the start date.
      expect(html).toContain("15");
      expect(html).toContain("17");
      expect(html).toContain("July");
    });
  });

  describe("admin attendee check-in on multi-day booking", () => {
    test("check-in works for attendee with multi-day booking", async () => {
      const { handleRequest } = await import("#routes");
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      const result = await bookAttendee(listing, {
        date: "2026-08-01",
        durationDays: 3,
      });
      if (!result.success) throw new Error("setup");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${result.attendees[0]!.id}/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const attendees = await getAttendeesRaw(listing.id);
      const checkedIn = attendees.find((a) => a.id === result.attendees[0]!.id);
      expect(Boolean(checkedIn?.checked_in)).toBe(true);
    });
  });

  describe("edge cases: realistic unusual scenarios", () => {
    test("1a: qty > 1 multi-day bookings aggregate per-day demand correctly", async () => {
      // Two bookings of qty=2 on a 3-day listing (cap 5). Each day sees 2+2=4 ≤ 5.
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
      });
      await bookAttendee(listing, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      const b = await bookAttendee(listing, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      expect(b.success).toBe(true);
    });

    test("1b: qty > 1 multi-day booking rejected when per-day total exceeds cap", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
      });
      await bookAttendee(listing, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      await bookAttendee(listing, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      // Third: 2+2+2=6 > 5 on every day → reject.
      const c = await bookAttendee(listing, {
        date: "2026-06-12",
        durationDays: 3,
        quantity: 2,
      });
      expect(c.success).toBe(false);
    });

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

    test("6: group cart with mismatched durations rejects when overlap days exceed cap", async () => {
      // ListingA is 2-day, ListingB is 4-day. Both in same group with cap=3.
      // Cart: qty=2 each → overlap on days 1-2 sees 4 > 3.
      const group = await createTestGroup({ maxAttendees: 3 });
      const listingA = await createDailyTestListing({
        durationDays: 2,
        groupId: group.id,
        maxAttendees: 100,
      });
      const listingB = await createDailyTestListing({
        durationDays: 4,
        groupId: group.id,
        maxAttendees: 100,
      });

      expect(
        await checkBatchAvailability(
          [
            { durationDays: 2, listingId: listingA.id, quantity: 2 },
            { durationDays: 4, listingId: listingB.id, quantity: 2 },
          ],
          "2026-08-01",
        ),
      ).toBe(false);
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
      expect(await hasAvailableSpots(listing.id, 1)).toBe(false);
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
