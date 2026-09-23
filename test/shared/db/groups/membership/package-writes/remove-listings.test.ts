/**
 * The batch write path that removes listings from one group. Removal runs the
 * same membership diff the listing form uses, so these pin the rows that must
 * not change too: memberships in other groups and their price overrides.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { removeListingsFromGroup } from "#db/groups/membership/package-writes.ts";
import { setGroupPackageMembers, setListingGroups } from "#db/groups.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  listingGroupIdsOf,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The flat price override rows one group's membership put on a listing. */
const groupOverrideRows = (listingId: number, groupId: number) =>
  queryAll<{ unit_price: number }>(
    "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = 'group' AND price_id = ?",
    [listingId, String(groupId)],
  );

describeWithEnv("db > groups > membership removal writes", { db: true }, () => {
  test("removing several listings at once removes only this group's memberships", async () => {
    const group = await createTestGroup({ name: "Night" });
    const one = await createTestListing({ name: "One" });
    const two = await createTestListing({ name: "Two" });
    await setListingGroups(one.id, [group.id]);
    await setListingGroups(two.id, [group.id]);

    expect(
      await removeListingsFromGroup([one.id, two.id], group.id),
    ).toBeNull();

    expect(await listingGroupIdsOf(one.id)).toEqual([]);
    expect(await listingGroupIdsOf(two.id)).toEqual([]);
  });

  test("removes ten members in one post without tripping the round-trip guard", async () => {
    const group = await createTestGroup({ name: "Big night" });
    const members = [];
    for (let index = 0; index < 10; index++) {
      members.push(await createTestListing({ name: `Member ${index}` }));
    }
    await Promise.all(
      members.map((listing) => setListingGroups(listing.id, [group.id])),
    );

    expect(
      await removeListingsFromGroup(
        members.map((listing) => listing.id),
        group.id,
      ),
    ).toBeNull();

    for (const listing of members) {
      expect(await listingGroupIdsOf(listing.id)).toEqual([]);
    }
  });

  test("a member of several groups keeps every other membership and override", async () => {
    const night = await createTestGroup({ name: "Night" });
    const day = await createTestGroup({ name: "Day" });
    const listing = await createTestListing({ name: "Shared" });
    await setListingGroups(listing.id, [night.id, day.id]);
    await setGroupPackageMembers(night.id, [
      { listingId: listing.id, price: 1500 },
    ]);
    await setGroupPackageMembers(day.id, [
      { listingId: listing.id, price: 900 },
    ]);

    expect(await removeListingsFromGroup([listing.id], night.id)).toBeNull();

    expect(await listingGroupIdsOf(listing.id)).toEqual([day.id]);
    expect(await groupOverrideRows(listing.id, night.id)).toEqual([]);
    expect(await groupOverrideRows(listing.id, day.id)).toEqual([
      { unit_price: 900 },
    ]);
  });

  test("removing from a deleted group reports the missing group", async () => {
    const listing = await createTestListing({ name: "Alone" });

    expect(await removeListingsFromGroup([listing.id], 999_999)).toBe(
      t("error.selected_group_deleted"),
    );
    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
  });

  test("a listing that is not a member is skipped without failing the batch", async () => {
    const group = await createTestGroup({ name: "Kept" });
    const member = await createTestListing({ name: "Member" });
    const outsider = await createTestListing({ name: "Outsider" });
    await setListingGroups(member.id, [group.id]);

    expect(
      await removeListingsFromGroup(
        [member.id, outsider.id, 999_999],
        group.id,
      ),
    ).toBeNull();

    expect(await listingGroupIdsOf(member.id)).toEqual([]);
    expect(await listingGroupIdsOf(outsider.id)).toEqual([]);
  });

  test("removing no listings touches nothing", async () => {
    const group = await createTestGroup({ name: "Quiet" });
    const listing = await createTestListing({ name: "Member" });
    await setListingGroups(listing.id, [group.id]);

    expect(await removeListingsFromGroup([], group.id)).toBeNull();

    expect(await listingGroupIdsOf(listing.id)).toEqual([group.id]);
  });

  test("a package member loses its price override on purpose", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Bundle" });
    const listing = await createTestListing({ name: "In the bundle" });
    await setListingGroups(listing.id, [group.id]);
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 1500, quantity: 2 },
    ]);
    expect((await groupOverrideRows(listing.id, group.id)).length).toBe(1);

    expect(await removeListingsFromGroup([listing.id], group.id)).toBeNull();

    // The membership row and its override both go, so re-adding the listing
    // starts from no override — same as unticking the box on its own form.
    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
    expect(await groupOverrideRows(listing.id, group.id)).toEqual([]);
  });
});
