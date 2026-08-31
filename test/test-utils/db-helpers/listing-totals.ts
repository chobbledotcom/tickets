import { listingAggregates } from "#db/listings/aggregates.ts";
import type { Listing } from "#types";
import { createTestAttendee } from "./attendees.ts";
import { createTestListing } from "./listings.ts";

/**
 * A listing with one booking, then its stored running totals pushed off that
 * truth. The starting point for any test about drift: the booking makes the
 * recounted totals 1 and 1, and `stored` is what the listing wrongly claims.
 */
export const createListingWithDriftedTotals = async (
  stored: { booked_quantity: number; tickets_count: number } = {
    booked_quantity: 9,
    tickets_count: 5,
  },
): Promise<Listing> => {
  const listing = await createTestListing({ maxAttendees: 100 });
  await createTestAttendee(
    listing.id,
    listing.slug,
    "Counted Person",
    "counted@example.com",
  );
  await listingAggregates.update(listing.id, stored);
  return listing;
};
