/**
 * `getOverlappingBookings` — the Logistics tab's "Other Attendees" query.
 *
 * Locks the half-open overlap contract (`start_at < windowEnd AND end_at >
 * windowStart`), the exclusions (the queried attendee itself, no-quantity rows,
 * date-less bookings) and the earliest-first ordering directly, rather than
 * only through the logistics-tab route test that renders it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { getOverlappingBookings } from "#shared/db/attendees/overlap.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import { execute } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

/** The window every test queries against: 2030-03-10 (inclusive) to 2030-03-12
 *  (exclusive), built the same way the booked ranges are so the boundary
 *  comparisons use matching stored formats. */
const WINDOW = dateToRange("2030-03-10", 2);

/** Book one attendee onto `listingId` and return their id. `date`/`durationDays`
 *  make it a dated range; omit `date` for a date-less booking. */
const book = async (
  name: string,
  listingId: number,
  booking: { date?: string; durationDays?: number; quantity?: number } = {},
): Promise<number> => {
  const result = await createAttendeeAtomic({
    bookings: [{ listingId, ...booking }],
    email: "",
    name,
  });
  // The fixtures always have capacity, so the create always succeeds.
  return (result as Extract<typeof result, { success: true }>).attendees[0]!.id;
};

describeWithEnv("db > attendees > overlap", { db: true }, () => {
  /** A daily listing with a cast of bookings around the query window: one for
   *  the "current" attendee (excluded), two genuine overlappers, and three that
   *  must be filtered out (two exactly adjacent, one far away). */
  const overlapFixture = async () => {
    const daily = await createDailyTestListing({ maxAttendees: 50 });
    const self = await book("Self", daily.id, {
      date: "2030-03-10",
      durationDays: 2,
    });
    const before = await book("Before Overlap", daily.id, {
      date: "2030-03-08",
      durationDays: 3,
    });
    const inside = await book("Inside", daily.id, {
      date: "2030-03-11",
      durationDays: 1,
      quantity: 2,
    });
    const adjacentBefore = await book("Adjacent Before", daily.id, {
      date: "2030-03-08",
      durationDays: 2,
    });
    const adjacentAfter = await book("Adjacent After", daily.id, {
      date: "2030-03-12",
      durationDays: 1,
    });
    const far = await book("Far Away", daily.id, {
      date: "2030-05-01",
      durationDays: 1,
    });
    const results = await getOverlappingBookings(
      self,
      WINDOW.startAt,
      WINDOW.endAt,
    );
    return {
      adjacentAfter,
      adjacentBefore,
      before,
      daily,
      far,
      ids: results.map((row) => row.attendee_id),
      inside,
      results,
      self,
    };
  };

  test("lists other attendees' overlapping bookings, earliest start first", async () => {
    const f = await overlapFixture();
    expect(f.ids).toEqual([f.before, f.inside]);
  });

  test("excludes the queried attendee's own overlapping booking", async () => {
    const f = await overlapFixture();
    expect(f.ids).not.toContain(f.self);
  });

  test("excludes a booking ending exactly when the window starts", async () => {
    const f = await overlapFixture();
    expect(f.ids).not.toContain(f.adjacentBefore);
  });

  test("excludes a booking starting exactly when the window ends", async () => {
    const f = await overlapFixture();
    expect(f.ids).not.toContain(f.adjacentAfter);
  });

  test("excludes a booking whose range is entirely outside the window", async () => {
    const f = await overlapFixture();
    expect(f.ids).not.toContain(f.far);
  });

  test("returns each overlapping booking's listing, quantity, and stored range", async () => {
    const f = await overlapFixture();
    const range = dateToRange("2030-03-11", 1);
    expect(f.results.find((row) => row.attendee_id === f.inside)).toMatchObject(
      {
        attendee_id: f.inside,
        end_at: range.endAt,
        listing_id: f.daily.id,
        quantity: 2,
        start_at: range.startAt,
      },
    );
  });

  test("excludes a no-quantity booking that would otherwise overlap", async () => {
    const daily = await createDailyTestListing({ maxAttendees: 50 });
    const zero = await book("Zero Quantity", daily.id, {
      date: "2030-03-10",
      durationDays: 2,
    });
    // Drop the booking to no quantity — a real "no quantity" attendee state the
    // overlap query filters out with `quantity > 0`.
    await execute(
      "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
      [zero],
    );
    const results = await getOverlappingBookings(
      0,
      WINDOW.startAt,
      WINDOW.endAt,
    );
    expect(results.map((row) => row.attendee_id)).not.toContain(zero);
  });

  test("excludes a date-less booking, keeping only the dated overlapper", async () => {
    const standard = await createTestListing({ maxAttendees: 10 });
    const dateless = await book("Dateless", standard.id);
    const daily = await createDailyTestListing({ maxAttendees: 50 });
    const dated = await book("Dated", daily.id, {
      date: "2030-03-11",
      durationDays: 1,
    });
    const results = await getOverlappingBookings(
      0,
      WINDOW.startAt,
      WINDOW.endAt,
    );
    expect(results.map((row) => row.attendee_id)).toEqual([dated]);
    expect(results.map((row) => row.attendee_id)).not.toContain(dateless);
  });
});
