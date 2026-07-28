/**
 * The write paths that change which listings belong to a group: the
 * add/remove diff behind the listing form's group checkboxes, the bulk
 * "add listings to this group" action, and the package-member replacement.
 * Each one skips work it does not need, so these tests pin both the rows that
 * change and the ones that must not.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  anyHiddenPackageGroup,
  anyListingInPackageGroup,
  assignListingsToGroup,
  getGroupPackagePrices,
  listingGroups,
  setGroupPackageMembers,
  setListingGroups,
} from "#shared/db/groups.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > groups > membership writes", { db: true }, () => {
  const groupIdsOf = async (listingId: number): Promise<number[]> =>
    [...(await listingGroups.getIds(listingId))].sort((a, b) => a - b);

  test("changing the group set adds and removes only what differs", async () => {
    const listing = await createTestListing({ name: "Diff Member" });
    const first = await createTestGroup({ name: "Diff One" });
    const second = await createTestGroup({ name: "Diff Two" });
    const third = await createTestGroup({ name: "Diff Three" });

    await setListingGroups(listing.id, [first.id, second.id]);
    expect(await groupIdsOf(listing.id)).toEqual(
      [first.id, second.id].sort((a, b) => a - b),
    );

    // Drops `first`, keeps `second`, adds `third` — all in one call.
    await setListingGroups(listing.id, [second.id, third.id]);
    expect(await groupIdsOf(listing.id)).toEqual(
      [second.id, third.id].sort((a, b) => a - b),
    );
  });

  test("setting the same group set again leaves the memberships alone", async () => {
    const listing = await createTestListing({ name: "Unchanged Member" });
    const group = await createTestGroup({ name: "Unchanged Group" });
    await setListingGroups(listing.id, [group.id]);

    await setListingGroups(listing.id, [group.id]);

    expect(await groupIdsOf(listing.id)).toEqual([group.id]);
  });

  test("an empty group set removes every membership", async () => {
    const listing = await createTestListing({ name: "Cleared Member" });
    const group = await createTestGroup({ name: "Cleared Group" });
    await setListingGroups(listing.id, [group.id]);

    await setListingGroups(listing.id, []);

    expect(await groupIdsOf(listing.id)).toEqual([]);
  });

  test("adding several listings at once records every one of them", async () => {
    const group = await createTestGroup({ name: "Bulk Add Group" });
    const one = await createTestListing({ name: "Bulk One" });
    const two = await createTestListing({ name: "Bulk Two" });

    await assignListingsToGroup([one.id, two.id], group.id);

    expect(await groupIdsOf(one.id)).toEqual([group.id]);
    expect(await groupIdsOf(two.id)).toEqual([group.id]);
  });

  test("adding no listings touches nothing", async () => {
    const group = await createTestGroup({ name: "Bulk Empty Group" });
    const listing = await createTestListing({ name: "Bulk Untouched" });

    await assignListingsToGroup([], group.id);

    expect(await groupIdsOf(listing.id)).toEqual([]);
  });

  test("no group ids means no group can match", async () => {
    // Both checks answer without a query when asked about nothing.
    expect(await anyHiddenPackageGroup([])).toBe(false);
    expect(await anyListingInPackageGroup([])).toBe(false);
  });

  test("only a package that hides its listings counts as hidden", async () => {
    const hidden = await createHiddenPackageGroup("Hidden Package Check");
    const plain = await createTestGroup({ name: "Plain Group Check" });
    const shownPackage = await createTestGroup({
      isPackage: true,
      name: "Shown Package Check",
    });

    expect(await anyHiddenPackageGroup([hidden.id])).toBe(true);
    expect(await anyHiddenPackageGroup([plain.id])).toBe(false);
    // A package that shows its listings has nothing to conceal.
    expect(await anyHiddenPackageGroup([shownPackage.id])).toBe(false);
  });

  test("replacing the package members with none clears their overrides", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Package Clear Group",
    });
    const listing = await createTestListing({ name: "Package Clear Member" });
    // Package overrides only apply to listings already in the group.
    await assignListingsToGroup([listing.id], group.id);
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 500, quantity: 1 },
    ]);
    expect((await getGroupPackagePrices(group.id)).length).toBe(1);

    await setGroupPackageMembers(group.id, []);

    // The listing stays in the package; only its price and quantity overrides
    // go back to "no override".
    expect(await getGroupPackagePrices(group.id)).toEqual([
      {
        group_id: group.id,
        listing_id: listing.id,
        package_price: null,
        quantity: 1,
      },
    ]);
    expect(await groupIdsOf(listing.id)).toEqual([group.id]);
  });

  test("a package member that is not a real listing is ignored", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Package Unknown Group",
    });
    const listing = await createTestListing({ name: "Package Real Member" });
    await assignListingsToGroup([listing.id], group.id);
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 500, quantity: 1 },
    ]);

    // 0 is never a listing id, so nothing in this call is valid and the
    // existing members must survive untouched.
    await setGroupPackageMembers(group.id, [
      { listingId: 0, price: 900, quantity: 1 },
    ]);

    expect(await groupIdsOf(listing.id)).toEqual([group.id]);
  });
});
