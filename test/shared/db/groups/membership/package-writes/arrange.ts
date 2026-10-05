/** Arrangers for the member-cap fences: a package plus one member, with the
 *  group write asked to save that member at a submitted pick count, or a
 *  stored pick count whose cap the operator then lowers. Shared by the
 *  package-write and membership cap suites so both judge the same state. */

import { execute, withTransaction } from "#db/client.ts";
import { writePackageMembersTx } from "#db/groups/membership/package-writes.ts";
import { validateListingGroupMembershipsTx } from "#db/groups/membership.ts";
import { setGroupPackageMembers } from "#db/groups.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** Judge one listing against one group through the listing-save membership
 *  fence, inside one transaction. Shared by the suites that read the outcome. */
export const judgeListingMembership = async (
  listingId: number,
  groupId: number,
) =>
  withTransaction((tx) =>
    validateListingGroupMembershipsTx(tx)([listingId], [groupId]),
  );

/** A hidden package with one member, with the group write asked to save the
 *  member at `submitted` pick counts against a `maxQuantity` per-order cap.
 *  `minimumQuantity` stores the listing's per-purchase floor beside the cap,
 *  so one suite can judge either bound alone. */
export const arrangeGroupWrite = async (
  name: string,
  submitted: number,
  maxQuantity: number,
  minimumQuantity?: number,
) => {
  const group = await createHiddenPackageGroup(`${name} group`);
  const member = await createTestListing({
    groupId: group.id,
    maxQuantity,
    ...(minimumQuantity === undefined ? {} : { minimumQuantity }),
    name,
  });
  return {
    group,
    member,
    run: () =>
      withTransaction((tx) =>
        writePackageMembersTx(
          tx,
          group.id,
          { hide_package_listings: false, is_package: true },
          { isPackage: true },
          [{ listingId: member.id, price: 0, quantity: submitted }],
        ),
      ),
  };
};

/** A hidden package with one stored member at `quantity` pick counts, whose
 *  per-order cap the operator then lowers to `maxQuantity` — the state a
 *  listing save must judge. */
export const arrangeStoredMember = async (
  name: string,
  quantity: number,
  maxQuantity: number,
) => {
  const group = await createHiddenPackageGroup(`${name} group`);
  const member = await createTestListing({
    groupId: group.id,
    maxQuantity: 2,
    name,
  });
  await setGroupPackageMembers(group.id, [
    { listingId: member.id, price: 0, quantity },
  ]);
  await execute("UPDATE listings SET max_quantity = ? WHERE id = ?", [
    maxQuantity,
    member.id,
  ]);
  return { group, member };
};
