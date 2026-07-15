import { listingGroups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** Load one listing and use it, or return the caller's documented missing
 * result. The shared singular path behind capacity methods that otherwise work
 * on arrays. */
export const useListingById = async <Result>(
  listingId: number,
  missing: Result,
  useListing: (listing: ListingWithCount) => Promise<Result>,
): Promise<Result> => {
  const listing = await getListingWithCount(listingId);
  return listing ? useListing(listing) : missing;
};

/** Group membership for a set of listings. */
export const getListingGroupMembership = (
  listings: readonly { id: number }[],
): Promise<Map<number, number[]>> =>
  listingGroups.getIdsByKeys(listings.map((listing) => listing.id));
