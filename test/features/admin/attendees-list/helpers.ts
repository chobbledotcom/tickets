/**
 * Shared fixtures for the attendees browser suites: listings with room to
 * spare, and a two-listing pair so a filter has something to drop.
 */

import type { ListingWithCount } from "#shared/types.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

export const makeListing = (
  name: string,
  maxAttendees = 100,
): Promise<ListingWithCount> =>
  createTestListing({ maxAttendees, name, thankYouUrl: "https://example.com" });

/** Two listings, each with one attendee, so a filter has something to drop. */
export const seedListingFilterPair = async (): Promise<{
  first: ListingWithCount;
  second: ListingWithCount;
}> => {
  const first = await makeListing("First Listing");
  const second = await makeListing("Second Listing");
  await createTestAttendeeDirect(first.id, "AliceOne", "a1@example.com");
  await createTestAttendeeDirect(second.id, "BobTwo", "b2@example.com");
  return { first, second };
};
