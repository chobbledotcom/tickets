/** Booking fixtures that span several listings — the shared-ticket shapes
 * the check-in suites and door stories read. */

import type { Attendee, Listing } from "#types";
import { createMultiBookingAttendee } from "./attendees.ts";
import { createTestListing } from "./listings.ts";

/** One attendee booked on two listings — one ticket token covering both
 * rows, exactly what a package order hands a guest. */
export const createTwoListingBooking = async (
  name: string,
  email: string,
): Promise<{ attendee: Attendee; first: Listing; second: Listing }> => {
  const first = await createTestListing({ maxAttendees: 10, name: "Doors" });
  const second = await createTestListing({
    maxAttendees: 10,
    name: "Workshop",
  });
  const attendee = await createMultiBookingAttendee(name, email, [
    { listingId: first.id },
    { listingId: second.id },
  ]);
  return { attendee, first, second };
};
