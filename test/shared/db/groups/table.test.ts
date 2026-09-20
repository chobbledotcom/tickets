/** The group_listings table module directly: both sides read and write the
 * same rows in opposite directions. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groupListings, listingGroups } from "#db/groups/table.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createGroupWithListings } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > group_listings table", { db: true }, () => {
  test("the group side reads the listing ids the link wrote", async () => {
    const {
      group,
      listings: [linked],
    } = await createGroupWithListings("Weekend", ["Linked hall"]);

    expect(await groupListings.getIds(group.id)).toEqual([linked.id]);
  });

  test("the listing side reads the group ids, with absent keys empty", async () => {
    const {
      group,
      listings: [linked],
    } = await createGroupWithListings("Sprint", ["Linked hall"]);
    const lone = await createTestListing({ name: "Free hall" });

    expect(await listingGroups.getIdsByKeys([linked.id, lone.id])).toEqual(
      new Map([
        [linked.id, [group.id]],
        [lone.id, []],
      ]),
    );
  });
});
