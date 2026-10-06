/** The submitted member-cap fence that lives in membership.ts
 *  (submittedMembersCapErrorTx): every submitted member is judged against
 *  its cap, one member exactly as much as several. The group-write driver
 *  around it is fenced in `package-writes/package-cap.test.ts`. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  arrangeGroupWrite,
  judgeListingMembership,
} from "./package-writes/arrange.ts";

describeWithEnv("db > groups > submitted member caps", { db: true }, () => {
  test("a lone submitted member is judged against its cap", async () => {
    const { run } = await arrangeGroupWrite("Solo Seat", 2, 1);

    await expect(run()).rejects.toThrow(
      t("error.package_member_cap", {
        max_quantity: 1,
        name: "Solo Seat",
        quantity: 2,
      }),
    );
  });
});

describeWithEnv("db > groups > submitted member minimums", { db: true }, () => {
  test("a package save refuses a pick count below the member's minimum", async () => {
    // The cap sits well above the floor, so only the minimum rule can refuse.
    const { run } = await arrangeGroupWrite("Batch Only", 1, 10, 2);

    await expect(run()).rejects.toThrow(
      t("error.package_member_min", {
        min_quantity: 2,
        name: "Batch Only",
        quantity: 1,
      }),
    );
  });

  test("a package save allows a pick count at the member's minimum", async () => {
    const { run } = await arrangeGroupWrite("Batch Pair", 2, 10, 2);

    await expect(run()).resolves.toBeUndefined();
  });

  test("a plain group save with the same below-minimum pick count is not refused", async () => {
    // The minimum judges package pick counts only; an ordinary group has no
    // pick count to judge.
    const group = await createTestGroup({ name: "Plain group" });
    const member = await createTestListing({
      groupId: group.id,
      maxQuantity: 10,
      minQuantity: 2,
      name: "Plain Member",
    });

    expect(await judgeListingMembership(member.id, group.id)).toEqual({
      error: null,
      listingMissing: false,
    });
  });
});
