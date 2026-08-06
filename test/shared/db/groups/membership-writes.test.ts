/**
 * The write paths that change which listings belong to a group. Each one skips
 * work it does not need, so these pin the rows that must not change too.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  TransactionValidationError,
  withTransaction,
  writeRowInTransaction,
} from "#shared/db/client.ts";
import { assignListingsToGroup } from "#shared/db/groups/membership.ts";
import {
  getGroupPackagePrices,
  getListingsByGroupId,
  listingGroups,
  setGroupPackageMembers,
  setListingGroups,
  setListingGroupsTx,
} from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import {
  generateUniqueListingSlug,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  getTestPackagePrices,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingInput } from "#test-utils/factories.ts";

describeWithEnv("db > groups > membership writes", { db: true }, () => {
  const groupIdsOf = async (listingId: number): Promise<number[]> =>
    [...(await listingGroups.getIds(listingId))].sort((a, b) => a - b);

  const sorted = (ids: number[]): number[] => ids.toSorted((a, b) => a - b);

  test("changing the group set adds and removes only what differs", async () => {
    const listing = await createTestListing({ name: "Diff Member" });
    const first = await createTestGroup({ name: "Diff One" });
    const second = await createTestGroup({ name: "Diff Two" });
    const third = await createTestGroup({ name: "Diff Three" });

    await setListingGroups(listing.id, [first.id, second.id]);
    expect(await groupIdsOf(listing.id)).toEqual(sorted([first.id, second.id]));

    // Drops `first`, keeps `second`, adds `third` — all in one call.
    await setListingGroups(listing.id, [second.id, third.id]);
    expect(await groupIdsOf(listing.id)).toEqual(sorted([second.id, third.id]));
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

  test("concurrent writes cannot give an empty group mixed listing types", async () => {
    const group = await createTestGroup({ name: "Concurrent Types" });
    const inputs = await Promise.all(
      [
        testListingInput({
          name: "Concurrent Standard",
        }),
        testListingInput({
          listingType: "daily",
          maximumDaysAfter: 30,
          minimumDaysBefore: 0,
          name: "Concurrent Daily",
        }),
      ].map(async (input) => ({
        ...input,
        ...(await generateUniqueListingSlug()),
        groupIds: [group.id],
      })),
    );

    // Both request-level checks finish while the group is empty. The write path
    // must make the same decision again after each transaction has the lock.
    expect(
      await Promise.all(inputs.map((input) => validateListingInput(input))),
    ).toEqual([null, null]);
    const writes = await Promise.allSettled(
      inputs.map(async (input) =>
        writeRowInTransaction(
          await listingsTable.insertStatement!(input),
          null,
          (tx, id) => setListingGroupsTx(tx, id, input.groupIds!),
        ),
      ),
    );

    if (writes[0]?.status === "rejected") throw writes[0].reason;

    expect(writes.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const dailyWrite = writes[1];
    if (dailyWrite?.status !== "rejected") {
      throw new Error("The daily listing write should have been rejected");
    }
    expect(dailyWrite.reason).toBeInstanceOf(TransactionValidationError);
    expect(
      new Set(
        (await getListingsByGroupId(group.id)).map(
          (listing) => listing.listing_type,
        ),
      ).size,
    ).toBe(1);
  });

  test("adding to a package rechecks fresh member rules", async () => {
    const packageGroup = await createTestGroup({
      isPackage: true,
      name: "Fresh Package Rules",
    });
    const payMore = await createTestListing({
      canPayMore: true,
      maxPrice: 200,
      name: "Fresh Pay More",
    });
    const parent = await createTestListing({ name: "Fresh Parent" });
    const addOn = await createTestListing({ name: "Fresh Add On" });
    await listingChildren.setIds(parent.id, [addOn.id]);

    await expect(
      withTransaction((tx) =>
        setListingGroupsTx(tx, payMore.id, [packageGroup.id]),
      ),
    ).rejects.toBeInstanceOf(TransactionValidationError);

    expect(
      await assignListingsToGroup([payMore.id], packageGroup.id),
    ).toContain("lets the buyer choose their own price");
    expect(await assignListingsToGroup([addOn.id], packageGroup.id)).toContain(
      "offered as an add-on",
    );
    expect(await groupIdsOf(payMore.id)).toEqual([]);
    expect(await groupIdsOf(addOn.id)).toEqual([]);
  });

  test("adding to a deleted group reports the missing group", async () => {
    const listing = await createTestListing({ name: "Missing Group Member" });

    expect(await assignListingsToGroup([listing.id], 999_999)).toBe(
      "Selected group does not exist",
    );
    expect(await groupIdsOf(listing.id)).toEqual([]);
  });

  test("a package member left out of the list loses its override", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Package Clear Group",
    });
    const named = await createTestListing({ name: "Package Named Member" });
    const other = await createTestListing({ name: "Package Other Member" });
    // Package overrides only apply to listings already in the group.
    await assignListingsToGroup([named.id, other.id], group.id);

    await setGroupPackageMembers(group.id, [
      { listingId: named.id, price: 700 },
    ]);
    expect(await getTestPackagePrices(group.id)).toEqual(
      new Map([[named.id, 700]]),
    );
    // An entry that names no quantity includes one of that member.
    const namedRow = (await getGroupPackagePrices(group.id)).find(
      ({ listing_id }) => listing_id === named.id,
    );
    if (!namedRow) throw new Error("The named member has no membership row");
    expect(namedRow.quantity).toBe(1);

    await setGroupPackageMembers(group.id, []);

    // The listings stay in the package; only their price and quantity go back
    // to "no override".
    expect(await getTestPackagePrices(group.id)).toEqual(new Map());
    const rows = await getGroupPackagePrices(group.id);
    expect(sorted(rows.map(({ listing_id }) => listing_id))).toEqual(
      sorted([named.id, other.id]),
    );
    expect(rows.map(({ quantity }) => quantity)).toEqual([1, 1]);
    expect(await groupIdsOf(named.id)).toEqual([group.id]);
  });

  test("a package member that is not in the group is ignored", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Package Unknown Group",
    });
    const member = await createTestListing({ name: "Package Real Member" });
    const outsider = await createTestListing({ name: "Package Outsider" });
    await assignListingsToGroup([member.id], group.id);
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 500 },
    ]);

    // A submission naming only a non-member is a no-op, not a full wipe.
    await setGroupPackageMembers(group.id, [
      { listingId: outsider.id, price: 999 },
    ]);
    expect(await getTestPackagePrices(group.id)).toEqual(
      new Map([[member.id, 500]]),
    );

    // A mixed submission applies the member entry and drops the non-member.
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 700 },
      { listingId: outsider.id, price: 999 },
    ]);
    expect(await getTestPackagePrices(group.id)).toEqual(
      new Map([[member.id, 700]]),
    );
  });
});
