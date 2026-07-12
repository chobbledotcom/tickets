import type { ListingWithCount } from "#shared/types.ts";

/** Index listings by their id, so a caller can look one up without scanning
 * the whole list each time. */
export const listingsById = (
  listings: readonly ListingWithCount[],
): Map<number, ListingWithCount> =>
  new Map(listings.map((listing) => [listing.id, listing]));
