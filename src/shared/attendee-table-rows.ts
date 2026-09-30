/**
 * Attendee table row construction — the one place that turns attendee booking
 * lines into `AttendeeTableRow`s for the unified attendee table.
 *
 * This module is pure: callers fetch (and decrypt) the attendees and listings;
 * these helpers only reshape them.
 */

import { type PairBookings, pairKey } from "#booking/ticket-moves.ts";
import { sumOf } from "#fp";
import { requireValue } from "#shared/required-value.ts";
import type {
  AttendeeRowListing,
  AttendeeTableRow,
  DisplayAttendee,
} from "#types";

/** One table row for a single booking line — the roster, check-in, calendar,
 * and group tables, where each line keeps its own date, quantity, and
 * per-listing check-in action. */
export const attendeeLineRow = (
  attendee: DisplayAttendee,
  listing: AttendeeRowListing,
): AttendeeTableRow => ({
  attendee,
  listings: [{ id: listing.id, name: listing.name }],
});

/** Attach each line's whole booking on its listing, read by `getPairBookings`.
 * A page can show only some of a pair's lines — one date, one filter — and
 * the check-in controls must still see the whole booking a check-in moves. */
export const withPairBookings =
  (bookings: PairBookings) =>
  (rows: readonly AttendeeTableRow[]): AttendeeTableRow[] =>
    rows.map((row) => {
      const key = pairKey(row.attendee.id, row.listings[0]!.id);
      return {
        ...row,
        booking: requireValue(bookings.get(key), `No booking read for ${key}`),
      };
    });

/**
 * Each row's listings keep `orderedListings` order, so the Listings cell
 * matches the listings page.
 *
 * A line whose listing is absent from that set is the LEFT-JOIN
 * `listing_id = 0` broken-linkage sentinel. It is dropped, and an attendee with
 * no surviving listing is omitted entirely.
 */
export const groupAttendeeRows = (
  attendees: DisplayAttendee[],
  orderedListings: readonly AttendeeRowListing[],
): AttendeeTableRow[] => {
  const rows: AttendeeTableRow[] = [];
  for (const lines of Map.groupBy(attendees, (a) => a.id).values()) {
    const bookedIds = new Set(lines.map((line) => line.listing_id));
    const listings = orderedListings
      .filter((listing) => bookedIds.has(listing.id))
      .map((listing) => ({ id: listing.id, name: listing.name }));
    if (listings.length === 0) continue;
    const quantity = sumOf((line: DisplayAttendee) => line.quantity)(lines);
    rows.push({ attendee: { ...lines[0]!, quantity }, listings });
  }
  return rows;
};
