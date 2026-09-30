import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { pairKey } from "#booking/ticket-moves.ts";
import {
  attendeeLineRow,
  groupAttendeeRows,
  withPairBookings,
} from "#shared/attendee-table-rows.ts";
import { testAttendee } from "#test-utils/factories.ts";
import type { AttendeeRowListing } from "#types";

/** Listings in display order: Gala (3) before Workshop (7) before Zumba (9) */
const DISPLAY_ORDER: AttendeeRowListing[] = [
  { id: 3, name: "Gala" },
  { id: 7, name: "Workshop" },
  { id: 9, name: "Zumba" },
];

describe("attendeeLineRow", () => {
  test("builds a one-listing row copying only the listing's id and name", () => {
    const attendee = testAttendee({ id: 5 });
    const row = attendeeLineRow(attendee, {
      extra: "ignored",
      id: 7,
      name: "Workshop",
    } as AttendeeRowListing);
    expect(row.attendee).toBe(attendee);
    expect(row.listings).toEqual([{ id: 7, name: "Workshop" }]);
  });
});

describe("withPairBookings", () => {
  const GALA = DISPLAY_ORDER[0]!;
  const WORKSHOP = DISPLAY_ORDER[1]!;

  test("gives each line the booking read for its person and listing", () => {
    const bookings = new Map([
      [pairKey(1, GALA.id), { checked_in: 1, quantity: 3 }],
      [pairKey(1, WORKSHOP.id), { checked_in: 0, quantity: 2 }],
    ]);
    const rows = withPairBookings(bookings)([
      attendeeLineRow(testAttendee({ id: 1, quantity: 1 }), GALA),
      attendeeLineRow(testAttendee({ id: 1, quantity: 2 }), WORKSHOP),
    ]);
    expect(rows.map((row) => row.booking)).toEqual([
      { checked_in: 1, quantity: 3 },
      { checked_in: 0, quantity: 2 },
    ]);
  });

  test("throws for a line whose booking was never read", () => {
    expect(() =>
      withPairBookings(new Map())([
        attendeeLineRow(testAttendee({ id: 4 }), GALA),
      ]),
    ).toThrow(`No booking read for ${pairKey(4, GALA.id)}`);
  });
});

describe("groupAttendeeRows", () => {
  test("merges one attendee's lines into a single row with every listing", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ id: 1, listing_id: 7 }),
        testAttendee({ id: 1, listing_id: 3 }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.listings).toEqual([
      { id: 3, name: "Gala" },
      { id: 7, name: "Workshop" },
    ]);
  });

  test("orders each row's listings by display order, not booking order", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ id: 1, listing_id: 9 }),
        testAttendee({ id: 1, listing_id: 7 }),
        testAttendee({ id: 1, listing_id: 3 }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows[0]!.listings.map((l) => l.name)).toEqual([
      "Gala",
      "Workshop",
      "Zumba",
    ]);
  });

  test("sums the quantity across an attendee's lines", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ id: 1, listing_id: 3, quantity: 2 }),
        testAttendee({ id: 1, listing_id: 7, quantity: 3 }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows[0]!.attendee.quantity).toBe(5);
  });

  test("keeps the first line's other attendee fields", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ date: "2026-03-01", id: 1, listing_id: 3 }),
        testAttendee({ date: "2026-04-01", id: 1, listing_id: 7 }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows[0]!.attendee.date).toBe("2026-03-01");
  });

  test("lists a listing once even when the attendee has several lines on it", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ date: "2026-03-01", id: 1, listing_id: 3 }),
        testAttendee({ date: "2026-03-02", id: 1, listing_id: 3 }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows[0]!.listings).toEqual([{ id: 3, name: "Gala" }]);
  });

  test("keeps distinct attendees on separate rows in first-seen order", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ id: 2, listing_id: 7, name: "Bob" }),
        testAttendee({ id: 1, listing_id: 3, name: "Alice" }),
        testAttendee({ id: 2, listing_id: 3, name: "Bob" }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows.map((r) => r.attendee.id)).toEqual([2, 1]);
    expect(rows[0]!.listings.map((l) => l.id)).toEqual([3, 7]);
    expect(rows[1]!.listings.map((l) => l.id)).toEqual([3]);
  });

  test("drops a line whose listing is unknown but keeps the attendee's other lines", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ id: 1, listing_id: 0 }),
        testAttendee({ id: 1, listing_id: 3 }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows[0]!.listings).toEqual([{ id: 3, name: "Gala" }]);
  });

  test("omits an attendee whose every line has an unknown listing", () => {
    const rows = groupAttendeeRows(
      [
        testAttendee({ id: 1, listing_id: 0 }),
        testAttendee({ id: 2, listing_id: 3 }),
      ],
      DISPLAY_ORDER,
    );
    expect(rows.map((r) => r.attendee.id)).toEqual([2]);
  });

  test("returns no rows for no lines", () => {
    expect(groupAttendeeRows([], DISPLAY_ORDER)).toEqual([]);
  });
});
