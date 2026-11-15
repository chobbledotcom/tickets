import type { BookAttendeeOpts } from "#test-utils/internal.ts";
import { bookAttendee, bookedAttendee } from "./attendee-payments.ts";
import { createTestListing } from "./listings.ts";

/** One attendee booked on a fresh listing, returned as its id. A payment-row
 *  suite names the contact details and gets the row identity it needs. */
export const bookedAttendeeId = async (
  booking: BookAttendeeOpts,
  maxAttendees = 50,
): Promise<number> =>
  bookedAttendee(
    await bookAttendee(await createTestListing({ maxAttendees }), booking),
  ).id;
