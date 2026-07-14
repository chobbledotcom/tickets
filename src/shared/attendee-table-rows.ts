/**
 * Attendee table row construction — the one place that turns attendee booking
 * lines into `AttendeeTableRow`s for the unified attendee table.
 *
 * This module is pure: callers fetch (and decrypt) the attendees and listings;
 * these helpers only reshape them.
 */

import { sumOf, unique } from "#fp";
import { t } from "#i18n";
import type {
  AttendeeRowListing,
  AttendeeTableRow,
  DisplayAttendee,
} from "#shared/types.ts";

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

/**
 * Group booking lines into one row per attendee, for the browsing tables
 * (the attendees list and the dashboard's newest attendees).
 *
 * `orderedListings` is the listing set in display order (see sortListings);
 * each row's listings keep that order, so the Listings cell matches the
 * listings page. Quantities sum across the attendee's lines — the order's
 * total tickets. Attendee order follows first appearance in `attendees`.
 * A positive listing id absent from `orderedListings` is a retained booking for
 * a deleted listing and stays visible as an unlinked placeholder. The LEFT-JOIN
 * `listing_id = 0` broken-linkage sentinel is still dropped.
 */
export const groupAttendeeRows = (
  attendees: DisplayAttendee[],
  orderedListings: readonly AttendeeRowListing[],
): AttendeeTableRow[] => {
  const rows: AttendeeTableRow[] = [];
  for (const lines of Map.groupBy(attendees, (a) => a.id).values()) {
    const bookedIds = new Set(lines.map((line) => line.listing_id));
    const liveListings = orderedListings
      .filter((listing) => bookedIds.has(listing.id))
      .map((listing) => ({ id: listing.id, name: listing.name }));
    const liveIds = new Set(orderedListings.map((listing) => listing.id));
    const deletedListings = unique(
      lines
        .map((line) => line.listing_id)
        .filter((listingId) => listingId > 0 && !liveIds.has(listingId)),
    ).map((id) => ({
      deleted: true as const,
      id,
      name: t("attendee_form.deleted_listing"),
    }));
    const listings = [...liveListings, ...deletedListings];
    if (listings.length === 0) continue;
    const quantity = sumOf((line: DisplayAttendee) => line.quantity)(lines);
    rows.push({ attendee: { ...lines[0]!, quantity }, listings });
  }
  return rows;
};
