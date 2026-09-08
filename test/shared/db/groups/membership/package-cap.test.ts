/** The package-member cap fences: the group write judges the submitted pick
 *  counts against each member's per-order cap, and the listing-side validator
 *  judges the stored ones. Split from the other membership mirrors so each
 *  file stays under the ~400-line target. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, withTransaction } from "#db/client.ts";
import {
  validateListingGroupMembershipsTx,
  writePackageMembersTx,
} from "#db/groups/membership.ts";
import { getGroupPackagePrices, setGroupPackageMembers } from "#db/groups.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A hidden package with one member, with the group write asked to save the
 *  member at `submitted` pick counts against a `maxQuantity` per-order cap. */
const arrangeGroupWrite = async (
  name: string,
  submitted: number,
  maxQuantity: number,
) => {
  const group = await createHiddenPackageGroup(`${name} group`);
  const member = await createTestListing({
    groupId: group.id,
    maxQuantity,
    name,
  });
  return {
    group,
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
const arrangeStoredMember = async (
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

describeWithEnv("db > groups > package member caps", { db: true }, () => {
  test("the group write refuses a pick count above the member's cap", async () => {
    const { run } = await arrangeGroupWrite("Single Seat", 2, 1);

    await expect(run()).rejects.toThrow(
      t("error.package_member_cap", {
        max_quantity: 1,
        name: "Single Seat",
        quantity: 2,
      }),
    );
  });

  test("the group write allows a pick count at the cap", async () => {
    const { group, run } = await arrangeGroupWrite("Pair Seat", 2, 2);

    await run();

    expect(await getGroupPackagePrices(group.id)).toEqual([
      expect.objectContaining({ package_price: 0, quantity: 2 }),
    ]);
  });

  test("the listing side refuses a stored pick count its lowered cap breaks", async () => {
    const { group, member } = await arrangeStoredMember("Stored Member", 2, 1);

    const result = await withTransaction((tx) =>
      validateListingGroupMembershipsTx(tx)([member.id], [group.id]),
    );

    expect(result).toEqual({
      error: t("error.package_member_cap", {
        max_quantity: 1,
        name: "Stored Member",
        quantity: 2,
      }),
      listingMissing: false,
    });
  });

  test("the listing side allows a stored pick count at the cap", async () => {
    const { group, member } = await arrangeStoredMember("Kept Member", 2, 2);

    const result = await withTransaction((tx) =>
      validateListingGroupMembershipsTx(tx)([member.id], [group.id]),
    );

    expect(result).toEqual({ error: null, listingMissing: false });
  });
});
