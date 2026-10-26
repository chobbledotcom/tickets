/**
 * A person a story names, booked by fixture on a listing the story also
 * names. The booking goes through the site's own create, so a story sets by
 * hand only the fact it is about.
 */

import type { ListingInput } from "#shared/catalog-fields/fields.ts";
// jscpd:ignore-start
import { rememberListing } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import type { Attendee, Listing } from "#types";

// jscpd:ignore-end

/** The booking fixture's own listing shape, with the booking's size beside
 * it. */
type BookingOverrides = { places?: number } & Partial<
  Omit<ListingInput, "slug" | "slugIndex">
>;

/** One person booked on one of the story's listings: the listing is created
 * under the name the story uses and kept there, and the booking carries the
 * person's own email. */
export const personBookedOnListing = async (
  world: TicketsWorld,
  who: string,
  listing: string,
  { places = 1, ...listingOverrides }: BookingOverrides = {},
): Promise<{ attendee: Attendee; listing: Listing; token: string }> => {
  const created = await createTestAttendeeWithToken(
    who,
    `${who.toLowerCase()}@example.com`,
    { name: listing, ...listingOverrides },
    places,
  );
  rememberListing(world, listing, created.listing);
  world.things.remember("record", who, created.attendee.id);
  return created;
};
