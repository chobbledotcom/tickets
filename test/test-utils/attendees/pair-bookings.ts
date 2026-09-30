import {
  type PairBookings,
  pairBookingsOf,
  type StoredTicketLine,
} from "#booking/ticket-moves.ts";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import type {
  AttendeeRowListing,
  AttendeeTableRow,
  DisplayAttendee,
} from "#types";

/** A shown line: the person, its listing, and its own counts. */
type ShownLine = {
  checked_in: number;
  id: number;
  listingId: number;
  quantity: number;
  refunded?: boolean;
};

/** The bookings a page reads when the lines it shows are the pair's only
 * lines. A refunded or no-quantity line holds no ticket, as in the read. */
export const shownLineBookings = (lines: readonly ShownLine[]): PairBookings =>
  pairBookingsOf(
    lines.map((line) => ({ attendeeId: line.id, listingId: line.listingId })),
    lines
      .filter((line) => line.quantity > 0 && !line.refunded)
      .map(
        (line, index): StoredTicketLine => ({
          attendee_id: line.id,
          checked_in: line.checked_in,
          id: index,
          listing_id: line.listingId,
          quantity: line.quantity,
        }),
      ),
  );

/** A table row for a line that is its person's whole booking on the listing. */
export const bookedLineRow = (
  attendee: DisplayAttendee,
  listing: AttendeeRowListing,
): AttendeeTableRow => ({
  ...attendeeLineRow(attendee, listing),
  booking: { checked_in: attendee.checked_in, quantity: attendee.quantity },
});
