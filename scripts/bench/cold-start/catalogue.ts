/**
 * The database step of the benchmark catalogue seed. The cold-start support
 * loads this module on first use, because nothing may read the environment
 * before main sets it.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { newGroupValues, setListingGroups } from "#db/groups.ts";
import { createListing } from "#db/listings/records.ts";
import { records } from "#db/record-table.ts";

/** One group of the benchmark catalogue and the one listing in it. */
export type CatalogueEntry = {
  groupName: string;
  groupSlug: string;
  isPackage: boolean;
  listingName: string;
  listingSlug: string;
};

/** Add one group with one listing in it, and give back their ids. */
export const addGroupWithListing = async (
  entry: CatalogueEntry,
): Promise<{ groupId: number; listingId: number }> => {
  const group = await records.groups.insert(
    newGroupValues({
      isPackage: entry.isPackage,
      name: entry.groupName,
      slug: entry.groupSlug,
      slugIndex: await hmacHash(entry.groupSlug),
    }),
  );
  const listing = await createListing({
    maxAttendees: 100,
    maxPrice: 0,
    name: entry.listingName,
    slug: entry.listingSlug,
    slugIndex: await hmacHash(entry.listingSlug),
  });
  await setListingGroups(listing.id, [group.id]);
  return { groupId: group.id, listingId: listing.id };
};
