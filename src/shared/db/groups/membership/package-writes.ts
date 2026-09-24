/** The package half of a group write: every path that packages a group, sets
 *  its members, or assigns listings to it rechecks transaction-fresh state
 *  through the guards and fences here. */
/* jscpd:ignore-start -- imports */

import {
  inPlaceholders,
  resultRows,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import {
  type GroupListingSettings,
  groupListingSettingsError,
} from "#db/groups/homogeneity.ts";
import {
  type GroupState,
  groupStatesTx,
  type ListingState,
  listingStatesTx,
  packageMembersErrorTx,
  sitePlanMemberErrorTx,
  storedPlanMemberErrorTx,
  submittedMembersCapErrorTx,
} from "#db/groups/membership.ts";
import { listingGroups } from "#db/groups/table.ts";
import { hasPackageBookingsTx, setGroupPackageMembers } from "#db/groups.ts";
import { removeGroupPricesStatement } from "#db/listing-prices.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import {
  refusingTheWriteOn,
  TransactionValidationError,
} from "#db/transaction.ts";
import { compact, requiredMapValue } from "#fp";
import { t } from "#i18n";
import { groupLeavingOrphanedAddOnError } from "#shared/add-on-reachability.ts";
import type { PackageMemberInput } from "#shared/catalog-fields/fields.ts";

/* jscpd:ignore-end */

/** Rechecks every member after a group becomes a package or hides its members.
 *  A built-site plan can be no group's final member — ordinary or package —
 *  so that check runs before the package-only rules. */
const packageGroupMembersErrorTx = async (
  tx: TxScope,
  groupId: number,
): Promise<string | null> => {
  const state = (await groupStatesTx(tx, [groupId])).get(groupId);
  // The row write can lose a race to a delete; its normal read-back reports 404.
  if (!state) return null;
  const listings = await listingStatesTx(
    tx,
    state.members.map((listing) => listing.id),
  );
  return (
    (await sitePlanMemberErrorTx(listings)) ??
    packageMembersErrorTx(listings, state)
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
 *  package with sold tickets cannot be un-packaging. */
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

/** A membership write over one group: which listings, and the group they join
 * or leave. Returns the flash message when the write was refused, or null
 * when the membership changed. */
export type MembershipWrite = (
  listingIds: number[],
  groupId: number,
) => Promise<string | null>;

/** The deduplicated ids of one membership write. An empty selection returns
 * null: a write with nothing selected never opens a transaction. */
const selectedListingIds = (listingIds: number[]): number[] | null =>
  listingIds.length === 0 ? null : [...new Set(listingIds)];

/** Builds one membership write: nothing selected writes nothing, the ids are
 * deduplicated, the optional `prepare` check runs before the write
 * transaction opens, and the `write` itself runs inside it with the group
 * checked there. */
const membershipWrite =
  (steps: {
    prepare?: (ids: number[], groupId: number) => Promise<string | null>;
    write: (
      tx: TxScope,
      ids: number[],
      groupId: number,
    ) => Promise<string | null>;
  }) =>
  async (listingIds: number[], groupId: number): Promise<string | null> => {
    const ids = selectedListingIds(listingIds);
    if (ids === null) return null;
    const refusal = await steps.prepare?.(ids, groupId);
    if (refusal) return refusal;
    return withTransaction((tx) => steps.write(tx, ids, groupId));
  };

/** Adds listings after checking fresh group, listing, and edge state in one
 * write transaction. */
export const assignListingsToGroup: MembershipWrite = membershipWrite({
  write: async (tx, ids, groupId) => {
    const groups = await groupStatesTx(tx, [groupId]);
    const state = groups.get(groupId);
    if (!state) return t("error.selected_group_deleted");
    // Serialize the transaction reads: the connection allows one in-flight
    // statement, so concurrent tx.execute calls can interleave and reject.
    const listings = await listingStatesTx(tx, ids);
    if (listings.length !== ids.length) {
      return t("error.selected_listing_deleted");
    }
    const batchError = await addListingsBatchError(tx, listings, state);
    if (batchError) return batchError;
    // New members join with the default pick count of one, so their own cap
    // always fits; the group-edit fence judges every saved quantity.
    await tx.batch(groupListingAssignmentStatements(ids, groupId));
    return null;
  },
});

/** Removes listings from one group in one write transaction, with the
 * pair-shaped deletes the listing form's untick runs. One batch however many
 * members were chosen; a non-member is a no-op. */
export const removeListingsFromGroup: MembershipWrite = membershipWrite({
  // The listing form refuses an untick that orphans a child-scoped add-on;
  // the group page refuses it here, before the transaction opens.
  async prepare(ids, groupId) {
    const current = await listingGroups.getIdsByKeys(ids);
    const leaving = new Map(
      ids.map((id) => [
        id,
        requiredMapValue(
          current,
          id,
          "membership set for a leaving listing",
        ).filter((group) => group !== groupId),
      ]),
    );
    return groupLeavingOrphanedAddOnError(leaving);
  },
  async write(tx, ids, groupId) {
    // The removal judges no member rules, so the fresh group check reads the
    // group's existence alone — not the whole member list.
    const group = await tx.execute({
      args: [groupId],
      sql: "SELECT 1 FROM groups WHERE id = ? LIMIT 1",
    });
    if (group.rows.length === 0) return t("error.selected_group_deleted");
    await tx.batch([
      {
        args: [groupId, ...ids],
        sql: `DELETE FROM group_listings WHERE group_id = ? AND listing_id IN (${inPlaceholders(
          ids,
        )})`,
      },
      ...compact([removeGroupPricesStatement(ids, [groupId])]),
    ]);
    return null;
  },
});

/** The rejection reasons for one add-listings batch: a built-site plan joins
 *  no group (ordinary or package), a stored plan member holds every joiner
 *  out, every joiner must match the group's settings, and package rules hold
 *  for every joiner. */
const addListingsBatchError = async (
  tx: TxScope,
  listings: readonly ListingState[],
  state: GroupState,
): Promise<string | null> => {
  const sitePlanError = await sitePlanMemberErrorTx(listings);
  if (sitePlanError) return sitePlanError;
  const storedPlanError = await storedPlanMemberErrorTx(tx, [state]);
  if (storedPlanError) return storedPlanError;
  const siblings: GroupListingSettings[] = [...state.members];
  for (const checked of listings) {
    const typeError = groupListingSettingsError(siblings, checked);
    if (typeError) return typeError;
    siblings.push(checked);
  }
  return packageMembersErrorTx(listings, state);
};
