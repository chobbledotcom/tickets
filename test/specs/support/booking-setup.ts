/**
 * Somebody booking, as the setup for a story about something else.
 *
 * A story about texting or about forgetting a person needs a real booking
 * behind it, made the ordinary way, on a listing that asks for whichever
 * details that story needs. Doing it here once means the details a visitor
 * really typed are what those stories go on to work with.
 */

import { rememberListing } from "#test/specs/support/listings.ts";
import {
  bookingMadeDuring,
  visitorBooks,
} from "#test/specs/support/public-booking.ts";
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

/** Somebody books a place the ordinary way, and the number the site filed
 * them under comes back. The site's own thank-you page is kept, so the
 * booking finishes here rather than off at another site. Two people who book
 * the same name book the same thing, because that is what the words say. */
export const somebodyBooksThroughTheSite = async (
  world: TicketsWorld,
  { email, listingName, phone, who }: SomebodyBooking,
): Promise<{ attendeeId: number; listing: Listing }> => {
  await enablePublicSite();
  // Made once, so whether it asks for a phone number is settled by the first
  // person to book it.
  const listing =
    world.things.recall("listing", listingName) ??
    rememberListing(
      world,
      listingName,
      await createTestListing({
        fields: phone ? "email,phone" : "email",
        maxAttendees: 10,
        name: listingName,
        thankYouUrl: "",
      }),
    );
  const attendeeId = await bookingMadeDuring(listing.id, () =>
    visitorBooks(world, listing, { email, who, ...(phone ? { phone } : {}) }),
  );
  return { attendeeId, listing };
};
