import { bookListing } from "#test-utils/api/helpers.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** Create a listing from `spec` and book it as Alice with `body`, returning
 *  the listing and the booking response together. */
export const createAndBook = async (
  spec: Parameters<typeof createTestListing>[0],
  body: Record<string, unknown>,
) => {
  const listing = await createTestListing(spec);
  const booked = await bookListing(listing.slug, body);
  return { listing, ...booked };
};
