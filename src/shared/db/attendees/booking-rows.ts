/** The booking rows of an attendee: on one listing, and in one slot. */

import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { type Condition, equal } from "#db/select/expression.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { deleteFrom, type Write } from "#db/write.ts";

/** The columns that name the booking slot of a row. */
type BookingSlot = Pick<
  ListingAttendeeRow,
  "listing_id" | "package_group_id" | "parent_listing_id" | "start_at"
>;

/** A test of one booking row. */
type BookingTest = (row: Node<"listing_attendees">) => Condition[];

/** The test that keeps the rows of the attendee on the listing. */
export const attendeeListingRows =
  (attendeeId: number, listingId: number): BookingTest =>
  (row) => [equal(row.attendeeId, attendeeId), equal(row.listingId, listingId)];

/** The test that keeps the row of the attendee in the slot of `booking`. A
 *  listing booked through several paths has one row in each slot. */
export const inBookingSlot =
  (attendeeId: number, booking: BookingSlot): BookingTest =>
  (row) => [
    ...attendeeListingRows(attendeeId, booking.listing_id)(row),
    equal(row.packageGroupId, booking.package_group_id),
    equal(row.parentListingId, booking.parent_listing_id),
    equal(row.startAt, booking.start_at),
  ];

/** The delete of the attendee's row in the slot of `booking`, and of no other
 *  row. */
export const bookingRowDelete = (
  attendeeId: number,
  booking: BookingSlot,
): Write<"listing_attendees"> =>
  deleteFrom(tables.listing_attendees).where(
    inBookingSlot(attendeeId, booking),
  );
