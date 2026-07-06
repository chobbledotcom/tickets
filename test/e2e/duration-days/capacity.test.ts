import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAvailableDates } from "#shared/dates.ts";
import {
  checkBatchAvailability,
  hasAvailableSpots,
} from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getListing, getListingWithCount } from "#shared/db/listings.ts";
import { buildTemplateData } from "#shared/email-renderer.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestGroup,
  createTestHoliday,
  describeWithEnv,
  makeTestEntry,
  rawListingRange,
  updateTestListing,
} from "#test-utils";

describeWithEnv(
  "e2e: multi-day bookings — capacity & availability",
  { db: true },
  () => {
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
      /** A capped group with a single-day "sat" listing and a 2-day "combo". */
      const groupWithSatAndCombo = async () => {
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
        return { combo, group, sat };
      };

      test("combo booking fills Saturday group cap across listings", async () => {
        const { combo, sat } = await groupWithSatAndCombo();

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
        const { combo, group, sat } = await groupWithSatAndCombo();
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
        expect(await hasAvailableSpots(listing.id, 1, "2026-08-11")).toBe(
          false,
        );
        // Day 12 is also occupied.
        expect(await hasAvailableSpots(listing.id, 1, "2026-08-12")).toBe(
          false,
        );
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
        expect(await hasAvailableSpots(listing.id, 1, "2026-08-14")).toBe(
          false,
        );

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
      const labelFor = async (
        listing: Parameters<typeof makeTestEntry>[0],
        attendee: Parameters<typeof makeTestEntry>[1],
      ) =>
        (
          await buildTemplateData(
            [makeTestEntry(listing, attendee)],
            "GBP",
            "https://example.com/t/ABC",
          )
        ).entries[0]!.attendee.date_range_label;

      test("multi-day booking shows en-dash range", async () => {
        // The label reflects the booking's stored span (end_date exclusive), so a
        // 3-day booking from the 12th ends (exclusive) on the 15th.
        expect(
          await labelFor(
            { duration_days: 3, listing_type: "daily" },
            { date: "2026-06-12", end_date: "2026-06-15" },
          ),
        ).toBe("12\u201314 June 2026");
      });

      test("single-day booking shows full date", async () => {
        expect(
          await labelFor(
            { duration_days: 1, listing_type: "daily" },
            { date: "2026-06-12" },
          ),
        ).toContain("12 June");
      });

      test("no-date booking shows empty string", async () => {
        expect(await labelFor({}, { date: null })).toBe("");
      });
    });
  },
);
