/**
 * Booking-slot identity — the single definition of "which row" a listing line
 * targets.
 *
 * A booking slot is `(listing_id, date, parent_listing_id, package_group_id)`:
 * the `listing_attendees` unique index is
 * `(listing_id, attendee_id, start_at, parent_listing_id, package_group_id)`,
 * so for one attendee a listing id plus its date, the parent it was folded
 * under, and the package it was booked through uniquely identify a row. The
 * `parentListingId` dimension keeps the same child listing chosen under two
 * different parents as two distinct rows; the `packageGroupId` dimension keeps
 * the same listing booked through two overlapping packages (or a package plus
 * its own standalone row) in one order as one faithful row per path. Both the
 * form-validation layer (which rejects duplicate lines before writing) and the
 * DB write layer (create + atomic edit) dedupe on this same identity, so it
 * lives in one dependency-free module they can all import without dragging in
 * the rest of the DB layer.
 *
 * The default `parentListingId = 0` / `packageGroupId = 0` mirrors the DB
 * defaults: standalone bookings, parent rows themselves, and legacy rows all
 * carry 0.
 */

/** Identity of a booking slot:
 * `${listingId}|${date}|${parentListingId}|${packageGroupId}`. Two rows with
 * the same slot would collide on the `listing_attendees` unique index. */
export const bookingSlotKey = (
  listingId: number,
  date: string | null | undefined,
  parentListingId = 0,
  packageGroupId = 0,
): string => `${listingId}|${date ?? ""}|${parentListingId}|${packageGroupId}`;

/** True when any two of the given lines target the same booking slot — which
 * the unique index would reject. Shared by the create and edit paths so the
 * slot identity is defined once. */
export const hasDuplicateBookingSlot = (
  lines: readonly {
    listingId: number;
    date?: string | null | undefined;
    parentListingId?: number | undefined;
    packageGroupId?: number | undefined;
  }[],
): boolean => {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = bookingSlotKey(
      line.listingId,
      line.date,
      line.parentListingId ?? 0,
      line.packageGroupId ?? 0,
    );
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};
