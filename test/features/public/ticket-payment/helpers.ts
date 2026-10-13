import {
  buildTicketListing,
  type TicketListing,
} from "#booking/model.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { requireValue } from "#shared/required-value.ts";

/** Fetch a listing with its live attendee count and wrap it as a TicketListing. */
export const ticketListingFor = async (
  listingId: number,
): Promise<TicketListing> => {
  const listing = requireValue(
    await getListingWithCount(listingId),
    `Listing ${listingId} is missing from the cache`,
  );
  return buildTicketListing(listing, false, undefined);
};
