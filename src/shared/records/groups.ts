/**
 * The group record: its table, its one write rule, its package-member write,
 * and its admin surface.
 */

import type { InValue } from "@libsql/client";
import { executeBatch, rowExists } from "#db/client.ts";
import {
  clearExternalLinksStatement,
  externalLinkTargets,
} from "#db/external-sources/target.ts";
import {
  type PackageFlags,
  readPackageFlagsTxOrNull,
  writePackageMembersTx,
} from "#db/groups/membership/package-writes.ts";
import {
  getGroupById,
  getListingsByGroupId,
  groups,
  isGroupSlugTaken,
  packageMembersError,
  resetGroupListings,
} from "#db/groups.ts";
import { clearImageUsesForItemStatement, imageUseTargets } from "#db/images.ts";
import {
  catalogNameLengthError,
  isNameTakenAnywhere,
} from "#db/name-registry.ts";
import { noteDeleteStatement } from "#db/notes/queries.ts";
import { clearItemEdgesStatement } from "#db/site-page-items.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import type { GroupInput } from "#shared/catalog-fields/fields.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import { ruleFromValidator } from "#shared/rest/record-command.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import type { Group } from "#types";

/** Shared shape of the group validators: an error message, or null when valid.
 * `id` is the group being edited (absent on create). */
export type GroupValidator = (
  input: GroupInput,
  id?: number,
) => Promise<string | null>;

const validateGroupSlug: GroupValidator = async (input, id) => {
  const taken = await isGroupSlugTaken(input.slug, id);
  return taken ? t("error.slug_in_use_group") : null;
};

/** Reject marking a group as a package when a current member cannot be packaged
 * (see {@link packageMembersError}) — including hiding a package whose member
 * gates children. A falsy `isPackage` is always fine. Returns a member-naming
 * error message, or null when valid. */
const validatePackageCompatibility = async (
  groupId: number,
  isPackage: boolean | undefined,
  hideListings: boolean | undefined,
): Promise<string | null> => {
  if (!isPackage) return null;
  return packageMembersError(await getListingsByGroupId(groupId), hideListings);
};

/** Error when the group is a HIDDEN package with sold tickets. Booking rows
 * keep its `package_group_id`, and a stale id resolves to NO package display.
 * Existing /t tickets and confirmation emails fall back to per-member
 * cards/rows and reveal the member names the hide flag concealed. Un-packaging
 * or deleting such a group is rejected until the operator clears the hide flag
 * first (an explicit reveal). A VISIBLE package still un-groups freely. */
export const soldHiddenPackageError = async (
  id: number,
): Promise<string | null> => {
  const group = await getGroupById(id);
  if (!group?.is_package || !group.hide_package_listings) {
    return null;
  }
  const sold = await rowExists(
    `SELECT 1 FROM listing_attendees
      WHERE package_group_id = ? AND quantity > 0 LIMIT 1`,
    [id],
  );
  return sold ? t("error.sold_hidden_package") : null;
};

/** Combined validation: slug uniqueness plus the package invariant. On create
 * (`id` undefined) the group has no members yet, so only the slug is checked.
 * Deleting or un-packaging a package with sold tickets is allowed for a
 * VISIBLE package: the group's items are un-grouped. The booking rows'
 * stored `package_group_id` stops resolving, and existing tickets fall back to
 * per-member cards. A HIDDEN sold package must not take that fall-back path
 * ({@link soldHiddenPackageError}). */
export const validateGroupWithPackage: GroupValidator = async (input, id) => {
  const nameTaken = await isNameTakenAnywhere(
    input.name,
    id === undefined ? undefined : { id: Number(id), kind: "group" },
  );
  if (nameTaken) return t("error.name_in_use");
  const nameLengthError = catalogNameLengthError(input.name);
  if (nameLengthError) return nameLengthError;
  const slugError = await validateGroupSlug(input, id);
  if (slugError) return slugError;
  if (id === undefined) return null;
  if (!input.isPackage) {
    const hiddenError = await soldHiddenPackageError(Number(id));
    if (hiddenError) return hiddenError;
  }
  return validatePackageCompatibility(
    id,
    input.isPackage,
    input.hidePackageListings,
  );
};

export const deleteGroup = async (id: InValue) => {
  const groupId = Number(id);
  await resetGroupListings(groupId);
  await executeBatch([
    clearItemEdgesStatement(sitePageItemTargets.of("group")(groupId)),
    clearImageUsesForItemStatement(imageUseTargets.of("group")(groupId)),
    clearExternalLinksStatement(externalLinkTargets.of("group")(groupId)),
    noteDeleteStatement("group", { args: [groupId], sql: "?" }),
    { args: [groupId], sql: "DELETE FROM groups WHERE id = ?" },
  ]);
};

/** The one group rule: the name, the slug, and the package invariants. */
const groupRule = ruleFromValidator<GroupInput, Group>(
  validateGroupWithPackage,
);

export const groupRecord = defineNamedRowRecord<
  Group,
  GroupInput,
  Group,
  PackageFlags | null
>({
  activityName: "Group",
  afterWrite: (tx, id, input, flags) =>
    writePackageMembersTx(
      tx,
      id,
      flags,
      input,
      input.isPackage === false ? [] : input.packageMembers,
    ),
  api: ADMIN_API_RESOURCES.groups,
  deleteDestination: "groupDelete",
  deleteRefusal: soldHiddenPackageError,
  getAll: () => groups.cache.getAll(),
  list: "groups",
  load: getGroupById,
  onDelete: (id) => deleteGroup(id),
  readState: readPackageFlagsTxOrNull,
  rule: groupRule,
  saveLanding: "group",
  table: groups.table,
});
