/**
 * Shared fixtures for the attendees browser suites: listings with room to
 * spare, a two-listing pair so a filter has something to drop, and a group
 * roster with an outside listing so the group filter has the same.
 */

import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createGroupWithListings } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { Group, ListingWithCount } from "#types";

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

/** One group holding two booked listings, plus a booked listing outside it,
 *  so a group filter has something to keep and something to drop. */
export const seedGroupRoster = async (): Promise<{
  group: Group;
  listings: { id: number; name: string }[];
  outside: ListingWithCount;
}> => {
  const { group, listings } = await createGroupWithListings("Autumn fair", [
    "Fair Door",
    "Fair Workshop",
  ]);
  const outside = await makeListing("Outside Show");
  const door = listings[0]!;
  const workshop = listings[1]!;
  await createTestAttendeeDirect(door.id, "FairOne", "f1@example.com");
  await createTestAttendeeDirect(workshop.id, "FairTwo", "f2@example.com");
  await createTestAttendeeDirect(outside.id, "OutsidePerson", "o@example.com");
  return { group, listings, outside };
};
