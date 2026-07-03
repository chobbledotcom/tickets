/**
 * Attendee table row construction — the one place that turns attendee booking
 * lines into `AttendeeTableRow`s for the unified attendee table.
 *
 * This module is pure: callers fetch (and decrypt) the attendees and listings;
 * these helpers only reshape them.
 */

import { sumOf } from "#fp";
import type {
  Attendee,
  AttendeeRowListing,
  AttendeeTableRow,
} from "#shared/types.ts";

/** One table row for a single booking line — the roster, check-in, calendar,
 * and group tables, where each line keeps its own date, quantity, and
 * per-listing check-in action. */
export const attendeeLineRow = (
  attendee: Attendee,
  listing: AttendeeRowListing,
): AttendeeTableRow => ({
  attendee,
  listings: [{ id: listing.id, name: listing.name }],
});

/**
 * Group booking lines into one row per attendee, for the browsing tables
 * (the attendees list and the dashboard's newest attendees).
 *
 * `orderedListings` is the listing set in display order (see sortListings);
 * each row's listings keep that order, so the Listings cell matches the
 * listings page. Quantities sum across the attendee's lines — the order's
 * total tickets. Attendee order follows first appearance in `attendees`.
 * A line whose listing is absent from `orderedListings` (the LEFT-JOIN
 * `listing_id = 0` broken-linkage sentinel) is dropped, and an attendee with
 * no surviving listing is omitted entirely — exactly which lines the
 * per-line tables skipped before grouping.
 */
export const groupAttendeeRows = (
  attendees: Attendee[],
  orderedListings: readonly AttendeeRowListing[],
): AttendeeTableRow[] => {
  const rows: AttendeeTableRow[] = [];
  for (const lines of Map.groupBy(attendees, (a) => a.id).values()) {
    const bookedIds = new Set(lines.map((line) => line.listing_id));
    const listings = orderedListings
      .filter((listing) => bookedIds.has(listing.id))
      .map((listing) => ({ id: listing.id, name: listing.name }));
    if (listings.length === 0) continue;
    const quantity = sumOf((line: Attendee) => line.quantity)(lines);
    rows.push({ attendee: { ...lines[0]!, quantity }, listings });
  }
  return rows;
};
