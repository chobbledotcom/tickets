import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";
import { createListingPair } from "./listing-pair.ts";

/** The named two-listing fixture: `names[0]` and `names[1]` carry the pair's
 *  settings, so a caller states the names once and the settings once. */
export const createNamedListingPair = async (
  names: readonly [string, string],
  first: TestListingOverrides = {},
  second: TestListingOverrides = first,
): Promise<[ListingWithCount, ListingWithCount]> =>
  await createListingPair(
    { ...first, name: names[0] },
    { ...second, name: names[1] },
  );
