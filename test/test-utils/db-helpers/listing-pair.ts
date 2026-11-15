import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";
import { createTestListing } from "./listings.ts";

/** Two listings created back-to-back — the fixture behind every multi-slug
 *  ticket test and every test that asserts a write reaches only the listing it
 *  names. Each side takes its own overrides, so one side can be full, inactive
 *  or priced differently from the other; a one-argument call gives both the
 *  same settings. */
export const createListingPair = async (
  first: TestListingOverrides = {},
  second: TestListingOverrides = first,
): Promise<[ListingWithCount, ListingWithCount]> => {
  const one = await createTestListing(first);
  return [one, await createTestListing(second)];
};
