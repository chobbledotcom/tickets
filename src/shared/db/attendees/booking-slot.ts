/**
 * Booking-slot identity — the single definition of "which row" a listing line
 * targets.
 *
 * A booking slot is `(listing_id, date, parent_listing_id)`: the
 * `listing_attendees` unique index is
 * `(listing_id, attendee_id, start_at, parent_listing_id)`, so for one
 * attendee a listing id plus its date plus the parent it was folded under
 * uniquely identifies a row. The `parentListingId` dimension means the same
 * child listing chosen under two different parents in one order produces two
 * distinct non-colliding slots — each with its own row recording which parent
 * it came from. Both the form-validation layer (which rejects duplicate lines
 * before writing) and the DB write layer (create + atomic edit) dedupe on this
 * same identity, so it lives in one dependency-free module they can all import
 * without dragging in the rest of the DB layer.
 *
 * The default `parentListingId = 0` mirrors the DB default: standalone
 * bookings, parent rows themselves, and legacy rows all carry 0.
 */

/** Identity of a booking slot: `${listingId}|${date}|${parentListingId}`. Two
 * rows with the same slot would collide on the `listing_attendees`
 * `(listing_id, attendee_id, start_at, parent_listing_id)` unique index. */
export const bookingSlotKey = (
  listingId: number,
  date: string | null | undefined,
  parentListingId = 0,
): string => `${listingId}|${date ?? ""}|${parentListingId}`;

/** True when any two of the given lines target the same booking slot — which
 * the unique index would reject. Shared by the create and edit paths so the
 * slot identity is defined once. */
export const hasDuplicateBookingSlot = (
  lines: readonly {
    listingId: number;
    date?: string | null;
    parentListingId?: number;
  }[],
): boolean => {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = bookingSlotKey(
      line.listingId,
      line.date,
      line.parentListingId ?? 0,
    );
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};
