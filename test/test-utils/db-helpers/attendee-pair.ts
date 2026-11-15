/** One attendee on each of two listings — the fixture behind every test that
 *  asserts a write reaches only the side it names. */

import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import type { Attendee, Listing } from "#types";

/** The owner details to book on one side. */
export type BookedPerson = { email: string; name: string };

/** The booking result for one side: the stored attendee and its ticket token. */
export type BookedOnListing = { attendee: Attendee; token: string };

/** Book the person named for each side on that side's listing, in order. */
export const bookAttendeePair = async (
  listings: readonly [Pick<Listing, "id">, Pick<Listing, "id">],
  people: readonly [BookedPerson, BookedPerson],
): Promise<[BookedOnListing, BookedOnListing]> => {
  const book = (side: 0 | 1): Promise<BookedOnListing> => {
    const { email, name } = people[side];
    return createTestAttendeeDirect(listings[side].id, name, email);
  };
  return [await book(0), await book(1)];
};
