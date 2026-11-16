import type { BlindIndex } from "#crypto/sealed.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { tables } from "#db/select/tables.ts";
import { toCamelCase } from "#shared/column-names.ts";
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
    tables.listings.columns.flatMap(([column]) =>
      column === "id" || column === "created"
        ? []
        : [[toCamelCase(column), stored[column]]],
    ),
  );
  return {
    ...columns,
    maxAttendees: listing.max_attendees,
    maxPrice: listing.max_price,
    name: listing.name,
    slug: listing.slug,
    slugIndex: listing.slug_index,
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
