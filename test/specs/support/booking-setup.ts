/**
 * Somebody booking, as the setup for a story about something else.
 *
 * A story about texting or about forgetting a person needs a real booking
 * behind it, made the ordinary way, on a listing that asks for whichever
 * details that story needs. Doing it here once means the details a visitor
 * really typed are what those stories go on to work with.
 */

import { rememberListing } from "#test/specs/support/listings.ts";
import { visitorBooks } from "#test/specs/support/public-booking.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import type { Listing } from "#types";

/** Who books, and what they leave behind. A phone number is only asked for
 * when the story needs one, because a listing that does not ask offers no box
 * to type it into. */
export interface SomebodyBooking {
  email: string;
  listingName: string;
  phone?: string;
  who: string;
}

/** Somebody books a place the ordinary way. The site's own thank-you page is
 * kept, so the booking finishes here rather than off at another site. */
export const somebodyBooksThroughTheSite = async (
  world: TicketsWorld,
  { email, listingName, phone, who }: SomebodyBooking,
): Promise<Listing> => {
  await enablePublicSite();
  const listing = rememberListing(
    world,
    listingName,
    await createTestListing({
      fields: phone ? "email,phone" : "email",
      maxAttendees: 10,
      name: listingName,
      thankYouUrl: "",
    }),
  );
  await visitorBooks(world, listing, {
    email,
    who,
    ...(phone ? { phone } : {}),
  });
  return listing;
};
