import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { ListingWithCount } from "#types";
import { createTestListing } from "./listings.ts";

type StoredQuantities = { maxQuantity?: number; minQuantity?: number };

/**
 * A listing whose stored quantity bounds the create form would refuse, such as
 * a minimum above the maximum. Tests that change a bound after a buyer opened
 * checkout need the stored row to carry the new value.
 */
export const createListingWithStoredQuantities = async (
  overrides: TestListingOverrides,
  stored: StoredQuantities,
): Promise<ListingWithCount> => {
  const listing = await createTestListing(overrides);
  const minQuantity = stored.minQuantity ?? listing.minQuantity;
  const maxQuantity = stored.maxQuantity ?? listing.maxQuantity;
  await execute(
    sql`UPDATE listings SET min_quantity = ${minQuantity}, max_quantity = ${maxQuantity} WHERE id = ${listing.id}`,
  );
  return { ...listing, maxQuantity: maxQuantity, minQuantity: minQuantity };
};
