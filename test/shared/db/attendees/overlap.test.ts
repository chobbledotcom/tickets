/**
 * `getOverlappingBookings` — the Logistics tab's "Other attendees" query.
 *
 * Locks the half-open overlap contract (`start_at < windowEnd AND end_at >
 * windowStart`), the exclusions (the queried attendee itself, servicing-kind
 * rows, no-quantity rows, date-less bookings), that overlaps are found across
 * every listing and every booking row, and the earliest-first ordering —
 * directly, rather than only through the logistics-tab route test that renders
 * it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { getOverlappingBookings } from "#shared/db/attendees/overlap.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import { execute } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { makeAttendee } from "#test-utils/logistics-tab.ts";

/**
 * The query window, with each bound made byte-for-byte equal to the stored
 * range column of the exactly-adjacent booking it must tie with. SQLite
 * compares TEXT byte-by-byte, and a stored `start_at` ("…T00:00:00Z") and
 * `end_at` ("…T00:00:00.000Z") use different suffixes — so a window built the
 * obvious way (`dateToRange("2030-03-10", 2)`) would exclude the adjacent rows
 * on a *formatting* mismatch instead of on the strict `<`/`>` overlap check,
 * and a change of those operators to inclusive ones would slip through. Anchor
 * the bounds instead:
 *   - startAt === adjacentBefore.end_at  ("2030-03-10T00:00:00.000Z")
 *   - endAt   === adjacentAfter.start_at ("2030-03-12T00:00:00Z")
 * so at each boundary the row's instant equals the window's exactly, and only
 * the strictness of the operator decides inclusion.
 */
const WINDOW = {
  endAt: dateToRange("2030-03-12", 1).startAt,
  startAt: dateToRange("2030-03-08", 2).endAt,
};

type BookingLine = {
  listingId: number;
  date?: string;
  durationDays?: number;
  quantity?: number;
};

/** Book one attendee onto a single listing. Omit `date` for a date-less
 *  booking. */
const bookOne = (
  name: string,
  listingId: number,
  booking: Omit<BookingLine, "listingId"> = {},
): Promise<number> => makeAttendee(name, [{ listingId, ...booking }]);

const overlappingIds = async (excludeId: number): Promise<number[]> =>
  (await getOverlappingBookings(excludeId, WINDOW.startAt, WINDOW.endAt)).map(
    (row) => row.attendee_id,
  );

describeWithEnv("db > attendees > overlap", { db: true }, () => {
  /** A daily listing with a cast of bookings around the query window: one for
   *  the "current" attendee (excluded), two genuine overlappers, and three that
   *  must be filtered out (two exactly adjacent, one far away). The later-dated
   *  overlapper is created first so booking ids run opposite to booking dates —
   *  the earliest-first assertion then fails if the query orders by id. */
  const overlapFixture = async () => {
    const daily = await createDailyTestListing({ maxAttendees: 50 });
    const self = await bookOne("Self", daily.id, {
      date: "2030-03-10",
      durationDays: 2,
    });
    const inside = await bookOne("Inside", daily.id, {
      date: "2030-03-11",
      durationDays: 1,
      quantity: 2,
    });
    const before = await bookOne("Before Overlap", daily.id, {
      date: "2030-03-08",
      durationDays: 3,
    });
    const adjacentBefore = await bookOne("Adjacent Before", daily.id, {
      date: "2030-03-08",
      durationDays: 2,
    });
    const adjacentAfter = await bookOne("Adjacent After", daily.id, {
      date: "2030-03-12",
      durationDays: 1,
    });
    const far = await bookOne("Far Away", daily.id, {
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
    // `before` was created after `inside`, so it has the higher id but the
    // earlier date — this only equals [before, inside] under a start_at sort.
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

  test("excludes an overlapping booking held by a servicing (non-attendee) row", async () => {
    const daily = await createDailyTestListing({ maxAttendees: 50 });
    const servicing = await bookOne("Servicing Hold", daily.id, {
      date: "2030-03-10",
      durationDays: 2,
    });
    // Turn the booking into a servicing hold — a real non-customer row the
    // overlap query filters out with `attendee.kind = 'attendee'`.
    await execute("UPDATE attendees SET kind = ? WHERE id = ?", [
      SERVICING_KIND,
      servicing,
    ]);
    expect(await overlappingIds(0)).not.toContain(servicing);
  });

  test("includes an overlapper booked on a different listing", async () => {
    const listingA = await createDailyTestListing({ maxAttendees: 50 });
    const listingB = await createDailyTestListing({ maxAttendees: 50 });
    const current = await bookOne("Current On A", listingA.id, {
      date: "2030-03-10",
      durationDays: 1,
    });
    const onB = await bookOne("Other On B", listingB.id, {
      date: "2030-03-11",
      durationDays: 1,
    });
    // The window is date-based, not listing-scoped: someone booked on a
    // different listing in the same days is still an "other attendee".
    expect(await overlappingIds(current)).toContain(onB);
  });

  test("returns every overlapping row of an attendee with several bookings", async () => {
    const listingA = await createDailyTestListing({ maxAttendees: 50 });
    const listingB = await createDailyTestListing({ maxAttendees: 50 });
    const multi = await makeAttendee("Two Bookings", [
      { date: "2030-03-10", durationDays: 1, listingId: listingA.id },
      { date: "2030-03-11", durationDays: 1, listingId: listingB.id },
    ]);
    const rows = (
      await getOverlappingBookings(0, WINDOW.startAt, WINDOW.endAt)
    ).filter((row) => row.attendee_id === multi);
    // Both booking lines overlap, so both rows come back — not one per attendee.
    expect(rows.map((row) => row.listing_id).sort()).toEqual(
      [listingA.id, listingB.id].sort(),
    );
  });

  test("excludes a no-quantity booking that would otherwise overlap", async () => {
    const daily = await createDailyTestListing({ maxAttendees: 50 });
    const zero = await bookOne("Zero Quantity", daily.id, {
      date: "2030-03-10",
      durationDays: 2,
    });
    // Drop the booking to no quantity — a real "no quantity" attendee state the
    // overlap query filters out with `quantity > 0`.
    await execute(
      "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
      [zero],
    );
    expect(await overlappingIds(0)).not.toContain(zero);
  });

  test("excludes a date-less booking, keeping only the dated overlapper", async () => {
    const standard = await createTestListing({ maxAttendees: 10 });
    const dateless = await bookOne("Dateless", standard.id);
    const daily = await createDailyTestListing({ maxAttendees: 50 });
    const dated = await bookOne("Dated", daily.id, {
      date: "2030-03-11",
      durationDays: 1,
    });
    const ids = await overlappingIds(0);
    expect(ids).toEqual([dated]);
    expect(ids).not.toContain(dateless);
  });
});
