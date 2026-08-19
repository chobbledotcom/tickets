/**
 * Bookings from OTHER attendees whose dates overlap a day range — the
 * Logistics tab's "Other Attendees" list, so an operator placing one job can
 * see everyone else booked on those days and jump between them.
 *
 * The overlap predicate is the same `start_at < end AND end_at > start` the
 * capacity checks use (`end_at` is the exclusive end of the booked range).
 */

import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { queryAll } from "#db/client.ts";
import type { AssignmentRow } from "#db/logistics.ts";

/** One overlapping booking line: the logistics leg columns plus when and
 * how many. */
export type OverlappingBooking = AssignmentRow & {
  start_at: string;
  end_at: string;
  quantity: number;
};

/**
 * Every real (quantity > 0) dated booking line from customers OTHER than
 * `attendeeId` that overlaps `[startAt, endAt)`, earliest first. Bookings
 * with no dates never overlap anything, so they are excluded by the
 * predicate itself.
 */
export const getOverlappingBookings = (
  attendeeId: number,
  startAt: string,
  endAt: string,
): Promise<OverlappingBooking[]> =>
  queryAll<OverlappingBooking>(
    `SELECT listingAttendee.attendee_id, listingAttendee.listing_id,
            listingAttendee.start_at, listingAttendee.end_at,
            listingAttendee.quantity,
            listingAttendee.start_agent_id, listingAttendee.end_agent_id,
            listingAttendee.start_time, listingAttendee.end_time
     FROM listing_attendees AS listingAttendee
     JOIN attendees AS attendee ON attendee.id = listingAttendee.attendee_id
     WHERE listingAttendee.attendee_id != ?
       AND attendee.kind = '${ATTENDEE_KIND}'
       AND listingAttendee.quantity > 0
       AND listingAttendee.start_at < ? AND listingAttendee.end_at > ?
     ORDER BY listingAttendee.start_at, listingAttendee.attendee_id, listingAttendee.listing_id`,
    [attendeeId, endAt, startAt],
  );
