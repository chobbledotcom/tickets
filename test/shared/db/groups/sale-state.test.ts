/**
 * The member sale state of one group: how many members it holds and how many
 * are on sale. The group page's Actions tab reads it to offer only the sale
 * switch that changes something, while the confirmation pages count the same
 * members from the listing read. Both must see the same membership, or the tab
 * offers a switch whose page then counts nothing.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupSaleState } from "#db/groups/sale-state.ts";
import { getListingsByGroupId } from "#db/groups.ts";
import { listingsTable } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** One group to build: the members it keeps on sale, the members it takes off
 *  sale, and the counts both reads must report for them. */
const CASES = [
  {
    expected: { activeCount: 0, listingCount: 0 },
    name: "No members",
    offSale: [],
    onSale: [],
  },
  {
    expected: { activeCount: 1, listingCount: 2 },
    name: "Mixed members",
    offSale: ["Off sale member"],
    onSale: ["On sale member"],
  },
  {
    expected: { activeCount: 0, listingCount: 2 },
    name: "All off sale",
    offSale: ["First off", "Second off"],
    onSale: [],
  },
];

describeWithEnv("db > group sale state", { db: true }, () => {
  for (const testCase of CASES) {
    test(`the sale state of "${testCase.name}" matches its members`, async () => {
      const group = await createTestGroup({ name: testCase.name });
      for (const name of testCase.onSale) {
        await createTestListing({ groupId: group.id, name });
      }
      for (const name of testCase.offSale) {
        const listing = await createTestListing({ groupId: group.id, name });
        await listingsTable.update(listing.id, { active: false });
      }
      const members = await getListingsByGroupId(group.id);
      const saleState = await getGroupSaleState(group.id);

      expect(saleState).toEqual(testCase.expected);
      // The confirmation pages count these same members, so the aggregate must
      // agree with the listing read for every group shape.
      expect(saleState).toEqual({
        activeCount: members.filter((member) => member.active).length,
        listingCount: members.length,
      });
    });
  }

  test("an id that names no group counts none of either", async () => {
    // The page loader reads this state beside the group row, before it knows
    // the group exists, so the aggregate must answer for a missing id.
    expect(await getGroupSaleState(999_999)).toEqual({
      activeCount: 0,
      listingCount: 0,
    });
  });
});
