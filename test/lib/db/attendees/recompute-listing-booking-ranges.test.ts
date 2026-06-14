import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  recomputeListingBookingRanges,
} from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  createDailyTestListing,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

const getRow = async (listingId: number) => {
  const res = await getDb().execute({
    args: [listingId],
    sql: "SELECT start_at, end_at FROM listing_attendees WHERE listing_id = ?",
  });
  return res.rows[0]!;
};

describeWithEnv(
  "db > attendees > recomputeListingBookingRanges",
  { db: true },
  () => {
    test("updates existing end_at to start_at + N days with ISO .000Z suffix", async () => {
      // Stored format must match fresh toISOString() output — locks lexical
      // comparisons to a single shape and keeps raw-row dumps tidy.
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        maximumDaysAfter: 30,
      });
      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", listingId: listing.id, quantity: 1 }],
        email: "fmt@example.com",
        name: "Fmt",
      });
      await recomputeListingBookingRanges(listing.id, 3);
      const row = await getRow(listing.id);
      expect(String(row.end_at)).toBe("2026-05-04T00:00:00.000Z");
    });

    test("clamps durationDays < 1 to 1", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 5,
        maximumDaysAfter: 30,
      });
      await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-05-01",
            durationDays: 2,
            listingId: listing.id,
            quantity: 1,
          },
        ],
        email: "c@example.com",
        name: "Clamp",
      });
      await recomputeListingBookingRanges(listing.id, 0);
      const row = await getRow(listing.id);
      const diffDays =
        (new Date(String(row.end_at)).getTime() -
          new Date(String(row.start_at)).getTime()) /
        86_400_000;
      expect(diffDays).toBe(1);
    });

    test("leaves non-daily (NULL start_at) rows alone", async () => {
      const daily = await createDailyTestListing({
        maxAttendees: 5,
        maximumDaysAfter: 30,
      });
      const standard = await createTestListing({
        listingType: "standard",
        maxAttendees: 5,
      });
      await createAttendeeAtomic({
        bookings: [
          { listingId: standard.id, quantity: 1 },
          { date: "2026-05-01", listingId: daily.id, quantity: 1 },
        ],
        email: "mix@example.com",
        name: "Mixed",
      });
      await recomputeListingBookingRanges(standard.id, 7);
      const row = await getRow(standard.id);
      expect(row.start_at).toBeNull();
      expect(row.end_at).toBeNull();
    });
  },
);
