import type { BlindIndex } from "#crypto/sealed.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { tables } from "#db/select/tables.ts";
import { fieldName } from "#shared/column-names.ts";
import type { ListingInput } from "#shared/records/listing-fields.ts";
import { testListingInput } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";

/** Build a complete listing input from the fields a behavior test varies. */
export const inputFor = (overrides: Partial<ListingInput>): ListingInput => ({
  ...testListingInput(overrides),
  slug: "some-slug",
  slugIndex: "some-index" as BlindIndex,
  ...overrides,
});

/** The input that a stored listing holds: each column except its id and its
 *  created time, named the way an input names it. */
const inputOfStored = (listing: ListingWithCount): ListingInput => {
  const stored: Readonly<Record<string, unknown>> = { ...listing };
  const columns: Partial<ListingInput> = Object.fromEntries(
    tables.listings.columns
      .map(([column]) => fieldName(column))
      .filter((key) => key !== "id" && key !== "created")
      .map((key) => [key, stored[key]]),
  );
  return {
    ...columns,
    maxAttendees: listing.maxAttendees,
    maxPrice: listing.maxPrice,
    name: listing.name,
    slug: listing.slug,
    slugIndex: listing.slugIndex,
  };
};

/** Build the update input for a stored listing, including its group membership. */
export const storedInputFor = async (
  listingId: number,
  overrides: Partial<ListingInput> = {},
): Promise<ListingInput> => {
  const listing = (await getListingWithCount(listingId))!;
  return {
    ...inputOfStored(listing),
    groupIds: await listingGroups.getIds(listingId),
    ...overrides,
  };
};
