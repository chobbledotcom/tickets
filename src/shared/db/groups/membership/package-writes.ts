/** The package half of a group write: every path that packages a group, sets
 *  its members, or assigns listings to it rechecks transaction-fresh state
 *  through the guards and fences here. */

import { resultRows, type TxScope, withTransaction } from "#db/client.ts";
import {
  type GroupListingSettings,
  groupListingSettingsError,
} from "#db/groups/homogeneity.ts";
import {
  groupStatesTx,
  listingStatesTx,
  packageMembersErrorTx,
  submittedMembersCapErrorTx,
} from "#db/groups/membership.ts";
import { hasPackageBookingsTx, setGroupPackageMembers } from "#db/groups.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import {
  refusingTheWriteOn,
  TransactionValidationError,
} from "#db/transaction.ts";
import { t } from "#i18n";
import type { PackageMemberInput } from "#shared/catalog-fields/fields.ts";

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
    for (const checked of listings) {
      const typeError = groupListingSettingsError(siblings, checked);
      if (typeError) return typeError;
      siblings.push(checked);
    }
    const packageError = await packageMembersErrorTx(listings, state);
    if (packageError) return packageError;
    // New members join with the default pick count of one, so their own cap
    // always fits; the group-edit fence judges every saved quantity.
    await tx.batch(groupListingAssignmentStatements(ids, groupId));
    return null;
  });
};
