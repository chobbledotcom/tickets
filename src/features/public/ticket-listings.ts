import { isRegistrationClosed } from "#routes/format.ts";
import {
  buildTicketListing,
  type TicketListing,
} from "#shared/booking/model.ts";
import { getGroupRemainingByListingId } from "#shared/db/attendees/capacity.ts";
import type { ListingWithCount } from "#shared/types.ts";

export const buildTicketListingsWithGroupCapacity = async (
  listings: ListingWithCount[],
): Promise<TicketListing[]> => {
  const groupRemaining = await getGroupRemainingByListingId(listings);
  return listings.map((e) =>
    buildTicketListing(e, isRegistrationClosed(e), groupRemaining.get(e.id)),
  );
};
