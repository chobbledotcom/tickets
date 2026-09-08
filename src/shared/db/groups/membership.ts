/** Group membership checks and writes that must see one transaction-local view. */

import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  inPlaceholders,
  resultRows,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import {
  checkGroupListingSettings,
  type GroupListingSettings,
  groupListingSettingsError,
} from "#db/groups/homogeneity.ts";
import {
  groupListings,
  hasPackageBookingsTx,
  setGroupPackageMembers,
} from "#db/groups.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import {
  refusingTheWriteOn,
  TransactionValidationError,
  txIdSet,
} from "#db/transaction.ts";
import { byId, mapNotNullish } from "#fp";
import { t } from "#i18n";
import type { PackageMemberInput } from "#shared/catalog-fields/fields.ts";
import {
  memberBlockKey,
  packageMemberCapError,
  packageMemberCapExceeded,
  packageMemberMessage,
} from "#shared/package-membership.ts";
import { requireValue } from "#shared/required-value.ts";
import type { ListingType } from "#types";

type GroupStateRow = {
  group_id: number;
  group_quantity: number;
  is_package: number;
  hide_package_listings: number;
  listing_id: number | null;
  listing_type: ListingType | null;
  customisable_days: number | null;
};

type GroupMember = GroupListingSettings & { quantity: number };

type GroupState = {
  isPackage: boolean;
  hideListings: boolean;
  members: GroupMember[];
};

/** Reads the group rows and all of their current member settings together,
 *  with each member's pick count (`group_listings.quantity`). */
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
                   groupRow.hide_package_listings,
                   COALESCE(groupListing.quantity, 1) AS group_quantity,
                   listing.id AS listing_id,
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
        quantity: row.group_quantity,
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
  max_quantity: number;
};

type ListingState = GroupListingSettings & {
  name: EnvKeyEncrypted;
  canPayMore: boolean;
  hasChildren: boolean;
  hasParents: boolean;
  maxQuantity: number;
};

/** Reads the package rules' listing fields, both edge directions, and the
 *  per-order cap in one query. */
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
                   listing.max_quantity,
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
    maxQuantity: row.max_quantity,
    name: row.name,
  }));
  const stateById = byId(states);
  return mapNotNullish((id: number) => stateById.get(id))(listingIds);
};

/** Checks the package rules against the transaction's current group and edge rows.
 *  Only decrypts the name of the first listing that fails a rule, so a large
 *  package with all-valid members does no crypto work under the write lock. */
const packageMembersErrorTx = async (
  listings: readonly ListingState[],
  group: GroupState,
): Promise<string | null> => {
  if (!group.isPackage) return null;
  for (const listing of listings) {
    const key = memberBlockKey(
      { can_pay_more: listing.canPayMore },
      {
        childIds: listing.hasChildren ? [listing.id] : [],
        parentIds: listing.hasParents ? [listing.id] : [],
      },
      group.hideListings,
    );
    if (key) {
      return packageMemberMessage(key, await decrypt(listing.name));
    }
  }
  return null;
};

/** The pick-count refusal for one listing against one membership quantity —
 *  the package must never demand more units of a member than the member
 *  sells in one order. Decrypts the name only for a member that fails. */
const memberCapErrorTx = async (
  listing: { maxQuantity: number; name: EnvKeyEncrypted },
  quantity?: number,
): Promise<string | null> =>
  packageMemberCapExceeded({ max_quantity: listing.maxQuantity, quantity })
    ? packageMemberCapError({
        max_quantity: listing.maxQuantity,
        name: await decrypt(listing.name),
        quantity,
      })
    : null;

/** The pick-count refusals for a save's submitted member quantities, judged
 *  against each member's stored cap. Only members the write will keep are
 *  judged (a stale or crafted id is dropped by the membership write itself);
 *  duplicate ids collapse last-wins, so a crafted repeat cannot dodge the
 *  check with a legal first entry. */
const submittedMembersCapErrorTx = async (
  tx: TxScope,
  groupId: number,
  members: PackageMemberInput[],
): Promise<string | null> => {
  const currentIds = new Set(await groupListings.getIdsTx(tx, groupId));
  const quantities = new Map(
    members
      .filter((member) => currentIds.has(member.listingId))
      .map((member) => [member.listingId, member.quantity]),
  );
  if (quantities.size === 0) return null;
  const states = await listingStatesTx(tx, [...quantities.keys()]);
  const stateById = byId(states);
  for (const [listingId, quantity] of quantities) {
    const capError = await memberCapErrorTx(
      requireValue(stateById.get(listingId), `Listing ${listingId} missing`),
      quantity,
    );
    if (capError) return capError;
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

/** One (listing, group) membership pair judged inside the write transaction:
 *  the group must exist, its members must stay homogeneous, the listing must
 *  obey the package rules, and the member's pick count must fit its cap. */
const oneMembershipErrorTx = async (
  listing: ListingState,
  states: Map<number, GroupState>,
  groupId: number,
): Promise<string | null> => {
  const checked = checkGroupListingSettings(
    states.get(groupId),
    (group) => group.members,
    listing,
    listing.id,
  );
  if (!checked.ok) return checked.error;
  const packageError = await packageMembersErrorTx([listing], checked.group);
  if (packageError) return packageError;
  if (!checked.group.isPackage) return null;
  // A membership row not yet inserted in this transaction (a fresh join)
  // serves one unit per package, always at or below the cap.
  const ownQuantity =
    checked.group.members.find((member) => member.id === listing.id)
      ?.quantity ?? 1;
  return memberCapErrorTx(listing, ownQuantity);
};

const listingGroupMembershipErrorTx = async (
  tx: TxScope,
  listings: readonly ListingState[],
  groupIds: readonly number[],
): Promise<string | null> => {
  const states = await groupStatesTx(tx, groupIds);
  for (const listing of listings) {
    for (const groupId of groupIds) {
      const error = await oneMembershipErrorTx(listing, states, groupId);
      if (error) return error;
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
const packageGroupMembersErrorTx = async (
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
const requirePackageGroupMembersTx = refusingTheWriteOn(
  packageGroupMembersErrorTx,
);

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

export type PackageFlags = {
  hide_package_listings: boolean;
  is_package: boolean;
};

type PackageFlagsRow = {
  hide_package_listings: number;
  is_package: number;
};

/** Reads only the flags that package write guards need. */
export const readPackageFlagsTxOrNull = async (
  tx: TxScope,
  id: number,
): Promise<PackageFlags | null> => {
  const row = resultRows<PackageFlagsRow>(
    await tx.execute({
      args: [id],
      sql: `SELECT groupRow.is_package, groupRow.hide_package_listings
              FROM groups AS groupRow
             WHERE groupRow.id = ?`,
    }),
  )[0];
  return row
    ? {
        hide_package_listings: row.hide_package_listings === 1,
        is_package: row.is_package === 1,
      }
    : null;
};

/** Runs both package guards in one call so every group write path applies the
 *  same transaction-local checks: package members stay valid, and a hidden
 *  package with sold tickets cannot be un-packaged. */
const requirePackageGuardsTx = async (
  tx: TxScope,
  groupId: number,
  flags: PackageFlags | null,
  isPackaging: boolean,
): Promise<void> => {
  await requirePackageGroupMembersTx(tx, groupId);
  const wasHiddenPackage =
    flags?.is_package === true && flags.hide_package_listings === true;
  await requireNotSoldHiddenPackageTx(
    tx,
    groupId,
    wasHiddenPackage,
    isPackaging,
  );
};

/** Guards a group write and replaces its package members in one call: every
 *  group write path applies the same sold-hidden check and the same "empty
 *  when un-packaging" rule, and no member's pick count may pass its cap.
 *  `flags` is the pre-update transaction snapshot. `members` is already
 *  resolved by the caller (parsed from a form or taken from the API input);
 *  pass `undefined` to leave existing overrides untouched. */
export const writePackageMembersTx = async (
  tx: TxScope,
  id: number,
  flags: PackageFlags | null,
  input: { isPackage?: boolean | undefined },
  members: PackageMemberInput[] | undefined,
): Promise<void> => {
  const isPackaging = input.isPackage !== false;
  if (members !== undefined && isPackaging) {
    const capError = await submittedMembersCapErrorTx(tx, id, members);
    if (capError) throw new TransactionValidationError(capError);
  }
  await requirePackageGuardsTx(tx, id, flags, isPackaging);
  if (members !== undefined) {
    await setGroupPackageMembers(id, isPackaging ? members : [], tx);
  }
};

const groupListingAssignmentStatements = (
  listingIds: readonly number[],
  groupId: number,
) =>
  listingIds.map((listingId) =>
    numberedStatement((bind) => {
      const listing = bind(listingId);
      return `INSERT OR IGNORE INTO group_listings (group_id, listing_id)
              SELECT ${bind(groupId)}, ${listing}
               WHERE EXISTS (SELECT 1 FROM listings WHERE id = ${listing})`;
    }),
  );

/** Adds listings after checking fresh group, listing, and edge state in one write transaction. */
export const assignListingsToGroup = async (
  listingIds: number[],
  groupId: number,
): Promise<string | null> => {
  if (listingIds.length === 0) return null;
  return withTransaction(async (tx) => {
    const ids = [...new Set(listingIds)];
    // Serialize the two transaction reads: the connection allows one in-flight
    // statement, so concurrent tx.execute calls can interleave and reject.
    const groups = await groupStatesTx(tx, [groupId]);
    const listings = await listingStatesTx(tx, ids);
    const state = groups.get(groupId);
    if (!state) return t("error.selected_group_deleted");
    if (listings.length !== ids.length) {
      return t("error.selected_listing_deleted");
    }
    const siblings: GroupListingSettings[] = [...state.members];
    for (const listing of listings) {
      const typeError = groupListingSettingsError(siblings, listing);
      if (typeError) return typeError;
      siblings.push(listing);
    }
    const packageError = await packageMembersErrorTx(listings, state);
    if (packageError) return packageError;
    // New members join with the default pick count of one, so their own cap
    // always fits; the group-edit fence judges every saved quantity.
    await tx.batch(groupListingAssignmentStatements(ids, groupId));
    return null;
  });
};
