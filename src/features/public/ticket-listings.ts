import { isRegistrationClosed } from "#routes/format.ts";
import { getGroupRemainingByListingId } from "#shared/db/attendees.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { buildTicketListing, type TicketListing } from "#templates/public.tsx";

export const buildTicketListingsWithGroupCapacity = async (
  listings: ListingWithCount[],
): Promise<TicketListing[]> => {
  const groupRemaining = await getGroupRemainingByListingId(listings);
  return listings.map((e) =>
    buildTicketListing(e, isRegistrationClosed(e), groupRemaining.get(e.id)),
  );
};
