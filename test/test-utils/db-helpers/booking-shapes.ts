import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeWithToken,
  setPendingNotificationFlags,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { Attendee, ListingWithCount } from "#types";

/** Remove every booking row of one attendee, the way a direct edit or a
 * deleted listing can leave an attendee with no booking. */
export const dropAttendeeBookings = async (
  attendeeId: number,
): Promise<void> => {
  await execute(
    sql`DELETE FROM listing_attendees WHERE attendee_id = ${attendeeId}`,
  );
};

/** An attendee that has a ticket token but no booking row: an orphan. */
export const attendeeWithoutBookings = async (
  name: string,
  email = `${name.toLowerCase()}@example.com`,
): Promise<{ attendee: Attendee; token: string }> => {
  const { attendee, token } = await createTestAttendeeWithToken(name, email);
  await dropAttendeeBookings(attendee.id);
  return { attendee, token };
};

/** One person booked on two listings. The first listing collects an email.
 * The second asks only for a phone number. One pending email flag sits on the
 * person, so only each booking's own listing can decide its email badge. */
export const personOnCollectingAndStoppedListings = async (
  label: string,
): Promise<{
  attendee: Attendee;
  collecting: ListingWithCount;
  stopped: ListingWithCount;
}> => {
  const collecting = await createTestListing({
    maxAttendees: 10,
    name: `${label} Ceilidh`,
  });
  const stopped = await createTestListing({
    fields: "phone",
    maxAttendees: 10,
    name: `${label} Quiz`,
  });
  const attendee = await createMultiBookingAttendee(
    `${label} Buyer`,
    `${label.toLowerCase()}-buyer@example.com`,
    [{ listingId: collecting.id }, { listingId: stopped.id }],
  );
  await setPendingNotificationFlags(attendee.id, 1, 0);
  return { attendee, collecting, stopped };
};
