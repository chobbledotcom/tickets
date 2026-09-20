/** The group_listings table module directly: both sides read and write the
 * same rows in opposite directions. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { groupListings, listingGroups } from "#db/groups/table.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > group_listings table", { db: true }, () => {
  test("the group side reads the listing ids the link wrote", async () => {
    const group = await createTestGroup({ name: "Weekend" });
    const listing = await createTestListing({ name: "Linked hall" });
    await assignListingsToGroup([listing.id], group.id);

    expect(await groupListings.getIds(group.id)).toEqual([listing.id]);
  });

  test("the listing side reads the group ids, with absent keys empty", async () => {
    const group = await createTestGroup({ name: "Sprint" });
    const listing = await createTestListing({ name: "Linked hall" });
    const lone = await createTestListing({ name: "Free hall" });
    await assignListingsToGroup([listing.id], group.id);

    const membership = await listingGroups.getIdsByKeys([listing.id, lone.id]);
    expect(membership.get(listing.id)).toEqual([group.id]);
    expect(membership.get(lone.id)).toEqual([]);
  });
});
