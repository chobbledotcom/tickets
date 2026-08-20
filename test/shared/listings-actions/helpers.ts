import type { BlindIndex } from "#crypto/sealed.ts";
import { listingGroups } from "#db/groups.ts";
import { getListingWithCount, listingsTable } from "#db/listings/records.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { testListingInput } from "#test-utils/factories.ts";

/** Build a complete listing input from the fields a behavior test varies. */
export const inputFor = (overrides: Partial<ListingInput>): ListingInput => ({
  ...testListingInput(overrides),
  slug: "some-slug",
  slugIndex: "some-index" as BlindIndex,
  ...overrides,
});

/** Build the update input for a stored listing, including its group membership. */
export const storedInputFor = async (
  listingId: number,
  overrides: Partial<ListingInput> = {},
): Promise<ListingInput> => {
  const listing = (await getListingWithCount(listingId))!;
  return {
    ...(listingsTable.rowToInput(listing, ["created"]) as ListingInput),
    groupIds: await listingGroups.getIds(listingId),
    ...overrides,
  };
};
