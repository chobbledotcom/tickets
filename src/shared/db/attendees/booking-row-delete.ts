/** The delete of one booking row of an attendee. */

import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { tables } from "#db/select/tables.ts";
import { deleteFrom, type Write } from "#db/write.ts";

/** The columns that name the booking slot of a row. */
type BookingSlot = Pick<
  ListingAttendeeRow,
  "listing_id" | "package_group_id" | "parent_listing_id" | "start_at"
>;

/** The delete of the attendee's row in the slot of `booking`, and of no other
 *  row. A listing booked through several paths keeps its other rows. */
export const bookingRowDelete = (
  attendeeId: number,
  booking: BookingSlot,
): Write<"listing_attendees"> =>
  deleteFrom(tables.listing_attendees).where({
    attendee_id: attendeeId,
    listing_id: booking.listing_id,
    package_group_id: booking.package_group_id,
    parent_listing_id: booking.parent_listing_id,
    start_at: booking.start_at,
  });
