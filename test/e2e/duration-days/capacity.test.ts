import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { buildTemplateData } from "#shared/email-renderer.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeTestEntry } from "#test-utils/factories.ts";

describeWithEnv(
  "e2e: multi-day bookings — capacity & availability",
  { db: true },
  () => {
    describe("per-day capacity", () => {
      // A 3-day listing (cap 2) whose middle day (the 13th) is already filled by
      // a 1-day booking at capacity.
      const threeDayListingWithFullMiddleDay = async () => {
        const listing = await createDailyTestListing({
          durationDays: 3,
          maxAttendees: 2,
        });
        await bookAttendee(listing, {
          date: "2026-06-13",
          durationDays: 1,
          quantity: 2,
        });
        return listing;
      };

      test("single day within a blocked multi-day range is still bookable alone", async () => {
        const listing = await threeDayListingWithFullMiddleDay();

        // Day 1 alone (before the full day) is still available.
        expect(
          await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-06-12", 1),
        ).toBe(true);
      });

      test("filling a tail day blocks the range but not the head", async () => {
        const listing = await createDailyTestListing({
          durationDays: 3,
          maxAttendees: 1,
        });
        await bookAttendee(listing, { date: "2026-06-14", durationDays: 1 });

        // 3-day starting 2026-06-12 touches 12,13,14 — day 14 full.
        expect(
          await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-06-12", 3),
        ).toBe(false);
        // Days 12 and 13 individually are fine.
        expect(
          await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-06-12", 1),
        ).toBe(true);
        expect(
          await attendeesApi.hasAvailableSpots(listing.id, 1, "2026-06-13", 1),
        ).toBe(true);
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
