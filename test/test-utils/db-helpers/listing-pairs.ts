/**
 * Listing pairs for the multi-ticket order suites: one order that books two
 * listings, so its later line is the one that overflows a sold-out or inactive
 * listing.
 */

import type { ListingWithCount } from "#types";
import { bookAttendee } from "./attendee-payments.ts";
import { createListingPair } from "./listing-pair.ts";

/**
 * Create a two-listing order whose SECOND listing holds a single slot, then
 * book that slot with the "first@example.com" filler, so any further booking
 * of the second line overflows. `names` and `unitPrice` give the
 * spare-capacity listing first and the single-slot listing second.
 */
export const createSoldOutListingPair = async (
  names: readonly [available: string, full: string],
  unitPrice: readonly [available: number, full: number],
): Promise<{ listing1: ListingWithCount; listing2: ListingWithCount }> => {
  const [listing1, listing2] = await createListingPair(
    { maxAttendees: 50, name: names[0], unitPrice: unitPrice[0] },
    { maxAttendees: 1, name: names[1], unitPrice: unitPrice[1] },
  );
  await bookAttendee(listing2, {
    email: "first@example.com",
    name: "First",
    paymentId: "pi_first",
  });
  return { listing1, listing2 };
};
