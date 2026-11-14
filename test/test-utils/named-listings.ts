import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { ListingWithCount } from "#types";

/** Create one standard listing per name, in the same order as `names`. A
 * fixture that needs several distinct listings names them here once instead of
 * repeating the create call per listing. */
export const createNamedListings = async <
  const Names extends readonly string[],
>(
  ...names: Names
): Promise<{ [Index in keyof Names]: ListingWithCount }> => {
  const listings: ListingWithCount[] = [];
  for (const name of names) {
    listings.push(await createTestListing({ name }));
  }
  // One listing was pushed per name, so the tuple shape holds.
  return listings as unknown as { [Index in keyof Names]: ListingWithCount };
};
