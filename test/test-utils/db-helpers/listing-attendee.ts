import { setupListingAndAttendee } from "#test-utils/attendees/helpers.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { Attendee, Listing } from "#types";

/** A fresh listing with `seats` places and one attendee booked on it. The
 *  `listing` record carries any other field the test needs. */
export const listingWithAttendee = (
  seats: number,
  name: string,
  email: string,
  listing: TestListingOverrides = {},
): Promise<{ attendee: Attendee; listing: Listing }> =>
  setupListingAndAttendee({
    email,
    listing: { maxAttendees: seats, ...listing },
    name,
  });
