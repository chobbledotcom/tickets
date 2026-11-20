/** A fixture for refund routes: an attendee who has paid nothing, so the route
 *  finds no payment to act on. */

import { listingWithAttendee } from "#test-utils/db-helpers/listing-attendee.ts";
import type { Attendee } from "#types";

/** An attendee booked on a fresh 100-seat listing, with no payment row. */
export const attendeeWithoutPayment = async (): Promise<Attendee> =>
  (await listingWithAttendee(100, "John Doe", "john@example.com")).attendee;
