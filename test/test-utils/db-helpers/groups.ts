import { listingGroups } from "#db/groups.ts";
import type { GroupInput } from "#shared/catalog-fields/fields.ts";
import type { Group } from "#types";
import { doAuthenticatedFormRequest } from "./request.ts";

/** The ids of the groups one listing belongs to, ascending. */
export const listingGroupIdsOf = async (listingId: number): Promise<number[]> =>
  [...(await listingGroups.getIds(listingId))].toSorted((a, b) => a - b);

export const createTestGroup = async (
  overrides: Partial<Omit<GroupInput, "slugIndex">> = {},
): Promise<Group> => {
  const input = {
    description: overrides.description ?? "",
    hidden: overrides.hidden ?? false,
    isPackage: overrides.isPackage ?? false,
    maxAttendees: overrides.maxAttendees ?? 0,
    name: overrides.name ?? "Test Group",
    termsAndConditions: overrides.termsAndConditions ?? "",
  };

  const group = await doAuthenticatedFormRequest(
    "/admin/groups",
    {
      description: input.description,
      max_attendees: String(input.maxAttendees),
      name: input.name,
      terms_and_conditions: input.termsAndConditions,
      ...(input.hidden ? { hidden: "1" } : {}),
      ...(input.isPackage ? { is_package: "1" } : {}),
    },
    async () => {
      const { groups } = await import("#db/groups.ts");
      const all = await groups.cache.getAll();
      return all[all.length - 1] as Group;
    },
    "create group",
  );

  if (overrides.slug) {
    return updateTestGroup(group.id, {
      description: group.description,
      hidden: group.hidden,
      maxAttendees: group.max_attendees,
      name: group.name,
      slug: overrides.slug,
      termsAndConditions: group.terms_and_conditions,
    });
  }

  return group;
};

/** Create a package group and hide its member listings — the "hidden package"
 * setup the buyer-privacy tests share (the members must never surface publicly;
 * only the package itself is a product). Returns the created group. */
export const createHiddenPackageGroup = async (
  name = "Bundle",
): Promise<Group> => {
  const group = await createTestGroup({ isPackage: true, name });
  const { groups } = await import("#db/groups.ts");
  // Return the updated row. The object from before the update still says the
  // package shows its members, so a caller reading the flag reads a stale one.
  return (await groups.table.update(group.id, {
    hidePackageListings: true,
  })) as Group;
};

export const updateTestGroup = async (
  groupId: number,
  updates: Partial<Omit<GroupInput, "slugIndex">>,
): Promise<Group> => {
  const { groups } = await import("#db/groups.ts");
  const existing = (await groups.table.read.one({ id: groupId })) as Group;

  const hidden = updates.hidden ?? existing.hidden;
  const isPackage = updates.isPackage ?? existing.is_package;
  return doAuthenticatedFormRequest(
    `/admin/groups/${groupId}/edit`,
    {
      description: updates.description ?? existing.description,
      max_attendees: String(updates.maxAttendees ?? existing.max_attendees),
      name: updates.name ?? existing.name,
      slug: updates.slug ?? existing.slug,
      terms_and_conditions:
        updates.termsAndConditions ?? existing.terms_and_conditions,
      ...(hidden ? { hidden: "1" } : {}),
      ...(isPackage ? { is_package: "1" } : {}),
    },
    async () => {
      const updated = await groups.table.read.one({ id: groupId });
      return updated as Group;
    },
    "update group",
  );
};

export const deleteTestGroup = async (groupId: number): Promise<void> => {
  const { groups } = await import("#db/groups.ts");
  const existing = (await groups.table.read.one({ id: groupId })) as Group;

  return doAuthenticatedFormRequest(
    `/admin/groups/${groupId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete group",
  );
};

/** A group's package price overrides as a listing-id → price map, keeping only
 * the listings that carry an override (a non-null price, including a free 0). */
export const getTestPackagePrices = async (
  groupId: number,
): Promise<Map<number, number>> => {
  const { getGroupPackagePrices, packageMemberMaps } = await import(
    "#db/groups.ts"
  );
  return packageMemberMaps(await getGroupPackagePrices(groupId)).prices;
};

/** Two roomy listings whose shared group has one place left in total. Each
 * fits alone, so only a check that counts an order's own lines together can
 * tell the second line tips the limit. */
export const createTwoListingsSharingOnePlace = async (): Promise<{
  first: { id: number };
  second: { id: number };
}> => {
  const shared = await createTestGroup({ maxAttendees: 1 });
  const { createTestListing } = await import("./listings.ts");
  const first = await createTestListing({
    groupId: shared.id,
    maxAttendees: 10,
  });
  const second = await createTestListing({
    groupId: shared.id,
    maxAttendees: 10,
  });
  return { first, second };
};

export type SoldPackageMember = {
  attendeeId: number;
  group: Group;
  member: { id: number; max_attendees: number; name: string; slug: string };
};

/** Creates a package group with one member listing and one attendee booked onto
 *  that member, then links the attendee to the package group. The `hidden`
 *  flag picks between a hidden package (members concealed from public listing)
 *  and a visible package (members shown normally). */
export const createSoldPackageMember = async (
  name: string,
  hidden: boolean,
): Promise<SoldPackageMember> => {
  const group = hidden
    ? await createHiddenPackageGroup(name)
    : await createTestGroup({ isPackage: true, name });
  const { createTestListing } = await import("./listings.ts");
  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    name: `${name} member`,
  });
  const { createTestAttendeeDirect } = await import("./attendees.ts");
  const { attendee } = await createTestAttendeeDirect(
    member.id,
    `${name} buyer`,
    `${name.toLowerCase().replace(/\s+/g, "-")}@example.com`,
    1,
    "",
    "",
    "",
    group.id,
  );
  return { attendeeId: attendee.id, group, member };
};
