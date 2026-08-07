/** Group membership checks and writes that must see one transaction-local view. */

import { mapNotNullish } from "#fp";
import { t } from "#i18n";
import type { PackageMemberInput } from "#shared/catalog-fields/fields.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  inPlaceholders,
  resultRows,
  TransactionValidationError,
  type TxScope,
  txIdSet,
  withTransaction,
} from "#shared/db/client.ts";
import {
  hasPackageBookingsTx,
  setGroupPackageMembers,
} from "#shared/db/groups.ts";
import { packageMemberError } from "#shared/package-membership.ts";
import { firstReason } from "#shared/reasons.ts";
import type { ListingType } from "#shared/types.ts";

/** The listing fields every group member must share. */
export type GroupListingSettings = {
  id: number;
  listing_type: ListingType;
  customisable_days: boolean;
};

/** Returns the first setting that conflicts with the group's existing members. */
export const groupListingTypeError = (
  allSiblings: readonly GroupListingSettings[],
  listingType: ListingType,
  customisableDays: boolean,
  excludeListingId?: number,
): string | null =>
  groupHomogeneityError(
    allSiblings.filter((listing) => listing.id !== excludeListingId),
    listingType,
    customisableDays,
  );

/** Checks one candidate listing against a group's current member settings. */
const groupListingSettingsError = (
  allSiblings: readonly GroupListingSettings[],
  listing: GroupListingSettings,
  excludeListingId?: number,
): string | null =>
  groupListingTypeError(
    allSiblings,
    listing.listing_type,
    listing.customisable_days,
    excludeListingId,
  );

/** A loaded group paired with the result of checking one listing against it. */
export type GroupListingCheck<Group> =
  | { group: Group; ok: true }
  | { error: string; group: null; ok: false };

/** Rejects a missing group or incompatible listing while preserving the loaded group. */
export const checkGroupListingSettings = <Group>(
  group: Group | undefined,
  members: (group: Group) => readonly GroupListingSettings[],
  listing: GroupListingSettings,
  excludeListingId?: number,
): GroupListingCheck<Group> => {
  if (!group) {
    return { error: "Selected group does not exist", group: null, ok: false };
  }
  const error = groupListingSettingsError(
    members(group),
    listing,
    excludeListingId,
  );
  return error ? { error, group: null, ok: false } : { group, ok: true };
};

const groupHomogeneityError = firstReason<
  [
    siblings: readonly GroupListingSettings[],
    listingType: ListingType,
    customisableDays: boolean,
  ]
>([
  (siblings, listingType) => {
    const mismatch = siblings.find(
      (sibling) => sibling.listing_type !== listingType,
    );
    return mismatch
      ? t("error.group_listing_type_mismatch", { type: mismatch.listing_type })
      : null;
  },
  (siblings, _listingType, customisableDays) => {
    const mismatch = siblings.find(
      (sibling) => sibling.customisable_days !== customisableDays,
    );
    return mismatch
      ? mismatch.customisable_days
        ? t("error.group_customisable_days_expected")
        : t("error.group_customisable_days_unexpected")
      : null;
  },
]);

type GroupStateRow = {
  group_id: number;
  is_package: number;
  hide_package_listings: number;
  listing_id: number | null;
  listing_type: ListingType | null;
  customisable_days: number | null;
};

type GroupState = {
  isPackage: boolean;
  hideListings: boolean;
  members: GroupListingSettings[];
};

/** Reads the group rows and all of their current member settings together. */
const groupStatesTx = async (
  tx: TxScope,
  groupIds: readonly number[],
): Promise<Map<number, GroupState>> => {
  const ids = [...new Set(groupIds)];
  if (ids.length === 0) return new Map();
  const rows = resultRows<GroupStateRow>(
    await tx.execute({
      args: ids,
      sql: `SELECT groupRow.id AS group_id, groupRow.is_package,
                   groupRow.hide_package_listings, listing.id AS listing_id,
                   listing.listing_type, listing.customisable_days
              FROM groups AS groupRow
              LEFT JOIN group_listings AS groupListing
                ON groupListing.group_id = groupRow.id
              LEFT JOIN listings AS listing ON listing.id = groupListing.listing_id
             WHERE groupRow.id IN (${inPlaceholders(ids)})`,
    }),
  );
  const states = new Map<number, GroupState>();
  for (const row of rows) {
    let state = states.get(row.group_id);
    if (!state) {
      state = {
        hideListings: row.hide_package_listings === 1,
        isPackage: row.is_package === 1,
        members: [],
      };
      states.set(row.group_id, state);
    }
    if (row.listing_id !== null) {
      state.members.push({
        customisable_days: row.customisable_days === 1,
        id: row.listing_id,
        listing_type: row.listing_type!,
      });
    }
  }
  return states;
};

/** Returns the set of group ids that are packages in the transaction's current
 *  view, so a catalog import derives package overrides from fresh state rather
 *  than a pre-transaction snapshot that can go stale. */
export const packageGroupIdsTx = (
  tx: TxScope,
  groupIds: readonly number[],
): Promise<Set<number>> =>
  txIdSet(tx, groupIds, (unique) => ({
    args: unique,
    sql: `SELECT id FROM groups WHERE is_package = 1 AND id IN (${inPlaceholders(unique)})`,
  }));

type ListingStateRow = Omit<GroupListingSettings, "customisable_days"> & {
  name: EnvKeyEncrypted;
  customisable_days: number;
  can_pay_more: number;
  has_children: number;
  has_parents: number;
};

type ListingState = GroupListingSettings & {
  name: EnvKeyEncrypted;
  canPayMore: boolean;
  hasChildren: boolean;
  hasParents: boolean;
};

/** Reads the package rules' listing fields and both edge directions in one query. */
const listingStatesTx = async (
  tx: TxScope,
  listingIds: readonly number[],
): Promise<ListingState[]> => {
  const ids = [...new Set(listingIds)];
  const rows = resultRows<ListingStateRow>(
    await tx.execute({
      args: ids,
      sql: `SELECT listing.id, listing.name, listing.listing_type,
                   listing.customisable_days, listing.can_pay_more,
                   EXISTS(SELECT 1 FROM listing_parents AS listingParent
                           WHERE listingParent.parent_listing_id = listing.id) AS has_children,
                   EXISTS(SELECT 1 FROM listing_parents AS listingParent
                           WHERE listingParent.child_listing_id = listing.id) AS has_parents
              FROM listings AS listing
             WHERE listing.id IN (${inPlaceholders(ids)})`,
    }),
  );
  const states: ListingState[] = rows.map((row) => ({
    canPayMore: row.can_pay_more === 1,
    customisable_days: row.customisable_days === 1,
    hasChildren: row.has_children === 1,
    hasParents: row.has_parents === 1,
    id: row.id,
    listing_type: row.listing_type,
    name: row.name,
  }));
  const byId = new Map(states.map((state) => [state.id, state]));
  return mapNotNullish((id: number) => byId.get(id))(listingIds);
};

/** Checks the package rules against the transaction's current group and edge rows. */
const packageMembersErrorTx = async (
  listings: readonly ListingState[],
  group: GroupState,
): Promise<string | null> => {
  if (!group.isPackage) return null;
  for (const listing of listings) {
    const error = packageMemberError(
      { can_pay_more: listing.canPayMore, name: await decrypt(listing.name) },
      {
        childIds: listing.hasChildren ? [listing.id] : [],
        parentIds: listing.hasParents ? [listing.id] : [],
      },
      group.hideListings,
    );
    if (error) return error;
  }
  return null;
};

/** Rechecks every selected group after the listing row write, before membership changes. */
export type ListingGroupMembershipValidation =
  | { listingMissing: true }
  | { error: string | null; listingMissing: false };

type MembershipsChecker<Result> = (
  listingIds: readonly number[],
  groupIds: readonly number[],
) => Promise<Result>;

const listingGroupMembershipErrorTx = async (
  tx: TxScope,
  listings: readonly ListingState[],
  groupIds: readonly number[],
): Promise<string | null> => {
  const states = await groupStatesTx(tx, groupIds);
  for (const listing of listings) {
    for (const groupId of groupIds) {
      const checked = checkGroupListingSettings(
        states.get(groupId),
        (group) => group.members,
        listing,
        listing.id,
      );
      if (!checked.ok) return checked.error;
      const packageError = await packageMembersErrorTx(
        [listing],
        checked.group,
      );
      if (packageError) return packageError;
    }
  }
  return null;
};

/** Rechecks selected listing/group membership pairs inside the write transaction. */
const validateListingGroupMembershipsWithChildStateTx = async (
  tx: TxScope,
  listingIds: readonly number[],
  groupIds: readonly number[],
  hasChildrenByListingId: ReadonlyMap<number, boolean>,
): Promise<ListingGroupMembershipValidation> => {
  const ids = [...new Set(listingIds)];
  const listings = (await listingStatesTx(tx, ids)).map((listing) => {
    const hasChildren = hasChildrenByListingId.get(listing.id);
    return hasChildren === undefined ? listing : { ...listing, hasChildren };
  });
  if (listings.length !== ids.length) return { listingMissing: true };
  return {
    error: await listingGroupMembershipErrorTx(tx, listings, groupIds),
    listingMissing: false,
  };
};

/** Rechecks selected listing/group membership pairs inside the write transaction. */
export const validateListingGroupMembershipsTx =
  (tx: TxScope): MembershipsChecker<ListingGroupMembershipValidation> =>
  (listingIds, groupIds) =>
    validateListingGroupMembershipsWithChildStateTx(
      tx,
      listingIds,
      groupIds,
      new Map(),
    );

/** Rechecks one listing's selected group memberships with its intended child state. */
export const validateListingGroupMembershipTx =
  (
    tx: TxScope,
  ): ((
    listingId: number,
    groupIds: readonly number[],
    hasChildren?: boolean,
  ) => Promise<ListingGroupMembershipValidation>) =>
  (listingId, groupIds, hasChildren) =>
    validateListingGroupMembershipsWithChildStateTx(
      tx,
      [listingId],
      groupIds,
      hasChildren === undefined
        ? new Map()
        : new Map([[listingId, hasChildren]]),
    );

/** Rechecks every member after a group becomes a package or hides its members. */
export const packageGroupMembersErrorTx = async (
  tx: TxScope,
  groupId: number,
): Promise<string | null> => {
  const state = (await groupStatesTx(tx, [groupId])).get(groupId);
  // The row write can lose a race to a delete; its normal read-back reports 404.
  if (!state) return null;
  return packageMembersErrorTx(
    await listingStatesTx(
      tx,
      state.members.map((listing) => listing.id),
    ),
    state,
  );
};

/** Stops the containing write when its changed group no longer has valid package members. */
export const requirePackageGroupMembersTx = async (
  tx: TxScope,
  groupId: number,
): Promise<void> => {
  const error = await packageGroupMembersErrorTx(tx, groupId);
  if (error) throw new TransactionValidationError(error);
};

/** Rechecks the sold-hidden invariant inside the write transaction: if the
 *  group was a hidden package and is being un-packaged, a checkout that
 *  committed between the request-level `soldHiddenPackageError` check and this
 *  write must roll back rather than reveal concealed member names. */
const requireNotSoldHiddenPackageTx = async (
  tx: TxScope,
  groupId: number,
  wasHiddenPackage: boolean,
  isPackaging: boolean,
): Promise<void> => {
  if (!wasHiddenPackage || isPackaging) return;
  if (await hasPackageBookingsTx(tx, groupId)) {
    throw new TransactionValidationError(t("error.sold_hidden_package"));
  }
};

/** The package-relevant slice of a stored group row, used to detect whether a
 *  write is un-packaging a hidden package that has sold tickets. */
type PackageRow = {
  hide_package_listings: boolean;
  is_package: boolean;
};

/** Runs both package guards in one call so every group write path applies the
 *  same transaction-local checks: package members stay valid, and a hidden
 *  package with sold tickets cannot be un-packaged. */
const requirePackageGuardsTx = async (
  tx: TxScope,
  groupId: number,
  existing: PackageRow | null,
  isPackaging: boolean,
): Promise<void> => {
  await requirePackageGroupMembersTx(tx, groupId);
  const wasHiddenPackage =
    existing?.is_package === true && existing?.hide_package_listings === true;
  await requireNotSoldHiddenPackageTx(
    tx,
    groupId,
    wasHiddenPackage,
    isPackaging,
  );
};

/** Guards a group write and replaces its package members in one call: every
 *  group write path applies the same sold-hidden check and the same "empty
 *  when un-packaging" rule. `members` is already resolved by the caller
 *  (parsed from a form or taken from the API input); pass `undefined` to leave
 *  existing overrides untouched. */
export const writePackageMembersTx = async (
  tx: TxScope,
  id: number,
  existing: PackageRow | null,
  input: { isPackage?: boolean | undefined },
  members: PackageMemberInput[] | undefined,
): Promise<void> => {
  const isPackaging = input.isPackage !== false;
  await requirePackageGuardsTx(tx, id, existing, isPackaging);
  if (members !== undefined) {
    await setGroupPackageMembers(id, isPackaging ? members : [], tx);
  }
};

const groupListingAssignmentStatements = (
  listingIds: readonly number[],
  groupId: number,
) =>
  listingIds.map((listingId) => ({
    args: [groupId, listingId, listingId],
    sql: "INSERT OR IGNORE INTO group_listings (group_id, listing_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM listings WHERE id = ?)",
  }));

/** Adds listings after checking fresh group, listing, and edge state in one write transaction. */
export const assignListingsToGroup = async (
  listingIds: number[],
  groupId: number,
): Promise<string | null> => {
  if (listingIds.length === 0) return null;
  return withTransaction(async (tx) => {
    const [groups, listings] = await Promise.all([
      groupStatesTx(tx, [groupId]),
      listingStatesTx(tx, listingIds),
    ]);
    const state = groups.get(groupId);
    if (!state) return "Selected group does not exist";
    const siblings = [...state.members];
    for (const listing of listings) {
      const typeError = groupListingSettingsError(siblings, listing);
      if (typeError) return typeError;
      siblings.push(listing);
    }
    const packageError = await packageMembersErrorTx(listings, state);
    if (packageError) return packageError;
    await tx.batch(groupListingAssignmentStatements(listingIds, groupId));
    return null;
  });
};
