/** The package-member cap fences: the group write judges the submitted pick
 *  counts against each member's per-order cap, and the listing-side validator
 *  judges the stored ones. Split from the other membership mirrors so each
 *  file stays under the ~400-line target. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices } from "#db/groups.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  arrangeGroupWrite,
  arrangeOrdinaryGroupPackaging,
  arrangeStoredMember,
  judgeListingMembership,
} from "./arrange.ts";

describeWithEnv("db > groups > package member caps", { db: true }, () => {
  test("turning an ordinary group into a package judges stored members", async () => {
    // The member stored the default pick count of one; the listing sells at
    // least two per purchase. Enabling the package without submitting
    // members keeps the stored count, so the write refuses it.
    const { run } = await arrangeOrdinaryGroupPackaging("Packaging Member", 2);

    await expect(run()).rejects.toThrow(
      t("error.package_member_min", {
        min_quantity: 2,
        name: "Packaging Member",
        quantity: 1,
      }),
    );
  });

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

    expect(await judgeListingMembership(member.id, group.id)).toEqual({
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

    expect(await judgeListingMembership(member.id, group.id)).toEqual({
      error: null,
      listingMissing: false,
    });
  });
});
