/**
 * Shared "fetch a listing by id, then build something from it" loader.
 *
 * The entity page loader and the QR context loader both fetch a listing and
 * return null when it is gone, then assemble their own shape from the row. This
 * keeps that fetch-then-null-guard in one place.
 */

import { getListingWithCount } from "#shared/db/listings/records.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** Load the listing with the given id and build a value from it, or null when
 *  no such listing exists. */
export const loadListingOr = async <T>(
  id: number,
  build: (listing: ListingWithCount) => T | Promise<T>,
): Promise<T | null> => {
  const listing = await getListingWithCount(id);
  if (!listing) return null;
  return build(listing);
};
