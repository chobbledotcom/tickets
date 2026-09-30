/** The booking lines a ticket count moves over: the live ticket lines of
 * each (person, listing) pair, in the order a count fills them. */

import {
  type PairBookings,
  pairBookingsOf,
  type StoredTicketLine,
  type TicketPair,
} from "#booking/ticket-moves.ts";
import {
  LISTING_ATTENDEE_REFUNDED_ROW,
  refundedForBooking,
} from "#db/attendees/select.ts";
import { inPlaceholders, queryAll } from "#db/client.ts";
import { unique } from "#fp";

/** Read the pairs' ticket lines. A no-quantity (quantity 0) line and a
 * refunded line are not tickets, so they never appear. */
export const ticketLinesQuery = (
  pairs: readonly TicketPair[],
): { args: number[]; sql: string } => {
  const attendeeIds = unique(pairs.map((pair) => pair.attendeeId));
  const listingIds = unique(pairs.map((pair) => pair.listingId));
  return {
    args: [...attendeeIds, ...listingIds],
    sql: `SELECT id, attendee_id, listing_id, quantity, checked_in
          FROM listing_attendees AS listingAttendee
          WHERE listingAttendee.attendee_id IN (${inPlaceholders(attendeeIds)})
            AND listingAttendee.listing_id IN (${inPlaceholders(listingIds)})
            AND listingAttendee.quantity > 0
            AND NOT (${refundedForBooking(LISTING_ATTENDEE_REFUNDED_ROW)})
          ORDER BY listingAttendee.start_at, listingAttendee.id`,
  };
};

/** Each pair's whole booking, keyed by `pairKey`. A page that shows only
 * some of a booking's lines still reads the whole booking here, because a
 * check-in moves the whole booking. */
export const getPairBookings = async (
  pairs: readonly TicketPair[],
): Promise<PairBookings> => {
  if (pairs.length === 0) return new Map();
  const { args, sql } = ticketLinesQuery(pairs);
  return pairBookingsOf(pairs, await queryAll<StoredTicketLine>(sql, args));
};
