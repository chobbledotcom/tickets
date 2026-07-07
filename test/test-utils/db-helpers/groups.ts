import type { GroupInput } from "#shared/db/groups.ts";
import type { Group } from "#shared/types.ts";
import { doAuthenticatedFormRequest } from "./request.ts";

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
      const { groups } = await import("#shared/db/groups.ts");
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
  const { groups } = await import("#shared/db/groups.ts");
  await groups.table.update(group.id, { hidePackageListings: true });
  return group;
};

export const updateTestGroup = async (
  groupId: number,
  updates: Partial<Omit<GroupInput, "slugIndex">>,
): Promise<Group> => {
  const { groups } = await import("#shared/db/groups.ts");
  const existing = (await groups.table.findById(groupId)) as Group;

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
      const updated = await groups.table.findById(groupId);
      return updated as Group;
    },
    "update group",
  );
};

export const deleteTestGroup = async (groupId: number): Promise<void> => {
  const { groups } = await import("#shared/db/groups.ts");
  const existing = (await groups.table.findById(groupId)) as Group;

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
    "#shared/db/groups.ts"
  );
  return packageMemberMaps(await getGroupPackagePrices(groupId)).prices;
};
