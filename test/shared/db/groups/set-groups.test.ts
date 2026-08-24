/**
 * The groups.ts write paths that replace a listing's group set and a package's
 * member overrides. Each one skips work it does not need, so these pin the
 * rows that must not change too.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction, writeRowInTransaction } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership.ts";
import {
  getGroupPackagePrices,
  getListingsByGroupId,
  setGroupPackageMembers,
  setListingGroups,
  setListingGroupsTx,
} from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { listingsTable } from "#db/listings/records.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { t } from "#i18n";
import {
  generateUniqueListingSlug,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
  getTestPackagePrices,
  listingGroupIdsOf,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingInput } from "#test-utils/factories.ts";

describeWithEnv("db > groups > set group memberships", { db: true }, () => {
  const sorted = (ids: number[]): number[] => ids.toSorted((a, b) => a - b);

  test("changing the group set adds and removes only what differs", async () => {
    const listing = await createTestListing({ name: "Diff Member" });
    const first = await createTestGroup({ name: "Diff One" });
    const second = await createTestGroup({ name: "Diff Two" });
    const third = await createTestGroup({ name: "Diff Three" });

    await setListingGroups(listing.id, [first.id, second.id]);
    expect(await listingGroupIdsOf(listing.id)).toEqual(
      sorted([first.id, second.id]),
    );

    // Drops `first`, keeps `second`, adds `third` — all in one call.
    await setListingGroups(listing.id, [second.id, third.id]);
    expect(await listingGroupIdsOf(listing.id)).toEqual(
      sorted([second.id, third.id]),
    );
  });

  test("setting the same group set again leaves the memberships alone", async () => {
    const listing = await createTestListing({ name: "Unchanged Member" });
    const group = await createTestGroup({ name: "Unchanged Group" });
    await setListingGroups(listing.id, [group.id]);

    await setListingGroups(listing.id, [group.id]);

    expect(await listingGroupIdsOf(listing.id)).toEqual([group.id]);
  });

  test("an empty group set removes every membership", async () => {
    const listing = await createTestListing({ name: "Cleared Member" });
    const group = await createTestGroup({ name: "Cleared Group" });
    await setListingGroups(listing.id, [group.id]);

    await setListingGroups(listing.id, []);

    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
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

    expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejectedWrites = writes.filter(({ status }) => status === "rejected");
    expect(rejectedWrites).toHaveLength(1);
    const rejectedWrite = rejectedWrites[0];
    if (rejectedWrite?.status !== "rejected") {
      throw new Error("One concurrent listing write should have been rejected");
    }
    expect(rejectedWrite.reason).toBeInstanceOf(TransactionValidationError);
    expect(rejectedWrite.reason.name).toBe("TransactionValidationError");
    expect(
      new Set(
        (await getListingsByGroupId(group.id)).map(
          (listing) => listing.listing_type,
        ),
      ).size,
    ).toBe(1);
  });

  test("validates a hidden package membership against children being cleared", async () => {
    const group = await createHiddenPackageGroup("Combined package update");
    const parent = await createTestListing({ name: "Combined parent" });
    const child = await createTestListing({ name: "Combined child" });
    await listingChildren.setIds(parent.id, [child.id]);

    await withTransaction(async (tx) => {
      await setListingGroupsTx(tx, parent.id, [group.id], false);
      await listingChildren.setIdsTx(tx, parent.id, []);
    });

    expect(await listingGroupIdsOf(parent.id)).toEqual([group.id]);
    expect(await listingChildren.getIds(parent.id)).toEqual([]);
  });

  test("listing-form membership rejects a deleted group", async () => {
    const listing = await createTestListing({ name: "Missing Form Group" });

    await expect(
      withTransaction((tx) => setListingGroupsTx(tx, listing.id, [999_999])),
    ).rejects.toMatchObject({ message: t("error.selected_group_deleted") });
    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
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
    expect(await listingGroupIdsOf(named.id)).toEqual([group.id]);
  });

  const packageWithOutsider = async (name: string) => {
    const group = await createTestGroup({ isPackage: true, name });
    const member = await createTestListing({ name: `${name} Member` });
    const outsider = await createTestListing({ name: `${name} Outsider` });
    await assignListingsToGroup([member.id], group.id);
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 500 },
    ]);
    return { group, member, outsider };
  };

  test("a submission naming only a non-member is a no-op, not a full wipe", async () => {
    const { group, member, outsider } = await packageWithOutsider(
      "Package Outsider Only",
    );

    await setGroupPackageMembers(group.id, [
      { listingId: outsider.id, price: 999 },
    ]);

    expect(await getTestPackagePrices(group.id)).toEqual(
      new Map([[member.id, 500]]),
    );
  });

  test("a mixed submission applies the member entry and drops the non-member", async () => {
    const { group, member, outsider } =
      await packageWithOutsider("Package Mixed");

    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 700 },
      { listingId: outsider.id, price: 999 },
    ]);

    expect(await getTestPackagePrices(group.id)).toEqual(
      new Map([[member.id, 700]]),
    );
  });
});
