/** Group membership checks and writes that must see one transaction-local view. */

import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { inPlaceholders, resultRows, type TxScope } from "#db/client.ts";
import {
  checkGroupListingSettings,
  type GroupListingSettings,
} from "#db/groups/homogeneity.ts";
import { groupListings } from "#db/groups.ts";
import { TransactionValidationError, txIdSet } from "#db/transaction.ts";
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

export type GroupMember = GroupListingSettings & { quantity: number };

export type GroupState = {
  isPackage: boolean;
  hideListings: boolean;
  members: GroupMember[];
};

/** Reads the group rows and all of their current member settings together,
 *  with each member's pick count (`group_listings.quantity`). */
export const groupStatesTx = async (
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
export const listingStatesTx = async (
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
export const packageMembersErrorTx = async (
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
export const submittedMembersCapErrorTx = async (
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

/** Refuses on any membership revalidation outcome, so a persisted pick count
 *  or homogeneity breach rolls the write back with its message. */
export const requireMembershipValidation = (
  membership: ListingGroupMembershipValidation,
): void => {
  if (membership.listingMissing) {
    throw new TransactionValidationError(t("catalog_transfer.member_missing"));
  }
  if (membership.error) throw new TransactionValidationError(membership.error);
};

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
