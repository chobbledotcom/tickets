/**
 * Booking-slot identity — the single definition of "which row" a listing line
 * targets.
 *
 * A booking slot is `(listing_id, date)`: the `listing_attendees` unique index
 * is `(listing_id, attendee_id, start_at)`, so for one attendee a listing id
 * plus its date uniquely identifies a row. Both the form-validation layer (which
 * rejects duplicate lines before writing) and the DB write layer (create + atomic
 * edit) dedupe on this same identity, so it lives in one dependency-free module
 * they can all import without dragging in the rest of the DB layer.
 */

/** Identity of a booking slot: `${listingId}|${date}`. Two rows with the same
 * slot would collide on the `listing_attendees` (listing_id, attendee_id,
 * start_at) unique index. */
export const bookingSlotKey = (
  listingId: number,
  date: string | null | undefined,
): string => `${listingId}|${date ?? ""}`;

/** True when any two of the given lines target the same booking slot — which
 * the unique index would reject. Shared by the create and edit paths so the
 * slot identity is defined once. */
export const hasDuplicateBookingSlot = (
  lines: readonly { listingId: number; date?: string | null }[],
): boolean => {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = bookingSlotKey(line.listingId, line.date);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};
