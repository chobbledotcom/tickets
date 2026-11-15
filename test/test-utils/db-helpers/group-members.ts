import type { Group, ListingWithCount } from "#types";
import { createHiddenPackageGroup, createTestGroup } from "./groups.ts";
import { createTestListing } from "./listings.ts";

/** A group holding exactly one listing. The membership is written through the
 *  listing create path, so a test that changes the set starts from a stored
 *  row. */
export const createGroupWithMember = async (
  groupName: string,
  listingName: string,
): Promise<{ group: Group; listing: ListingWithCount }> => {
  const group = await createTestGroup({ name: groupName });
  const listing = await createTestListing({
    groupIds: [group.id],
    name: listingName,
  });
  return { group, listing };
};

/** A hidden package group plus a parent and a child listing. The rows carry no
 *  edge and no membership: the caller links them the way its case needs. */
export const createHiddenPackagePair = async (
  groupName: string,
  parentName: string,
  childName: string,
): Promise<{
  child: ListingWithCount;
  group: Group;
  parent: ListingWithCount;
}> => {
  const group = await createHiddenPackageGroup(groupName);
  const parent = await createTestListing({ name: parentName });
  const child = await createTestListing({ name: childName });
  return { child, group, parent };
};
