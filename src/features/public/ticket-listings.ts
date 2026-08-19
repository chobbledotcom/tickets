import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import { getGroupRemainingByListingId } from "#db/attendees/capacity/groups.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import type { ListingWithCount } from "#types";

export const buildTicketListingsWithGroupCapacity = async (
  listings: ListingWithCount[],
): Promise<TicketListing[]> => {
  const groupRemaining = await getGroupRemainingByListingId(listings);
  return listings.map((e) =>
    buildTicketListing(e, isRegistrationClosed(e), groupRemaining.get(e.id)),
  );
};
