/**
 * The batch write path that adds listings to one group. It validates the whole
 * batch before touching the table, so these pin the rows that must not change
 * too. The single-listing group-set writers live in groups.ts and are tested
 * in `set-groups.test.ts`.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership.ts";
import { setListingGroupsTx } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
  listingGroupIdsOf,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > groups > membership writes", { db: true }, () => {
  test("adding several listings at once records every one of them", async () => {
    const group = await createTestGroup({ name: "Bulk Add Group" });
    const one = await createTestListing({ name: "Bulk One" });
    const two = await createTestListing({ name: "Bulk Two" });

    await assignListingsToGroup([one.id, two.id], group.id);

    expect(await listingGroupIdsOf(one.id)).toEqual([group.id]);
    expect(await listingGroupIdsOf(two.id)).toEqual([group.id]);
  });

  test("a vanished listing rejects the whole batch", async () => {
    const group = await createTestGroup({ name: "Vanished Batch Group" });
    const remaining = await createTestListing({ name: "Remaining Batch Row" });

    expect(
      await assignListingsToGroup(
        [remaining.id, remaining.id, 999_999],
        group.id,
      ),
    ).toBe(t("error.selected_listing_deleted"));
    expect(await listingGroupIdsOf(remaining.id)).toEqual([]);
  });

  test("an incompatible batch adds none of its listings", async () => {
    const group = await createTestGroup({ name: "Mixed Batch Group" });
    const standard = await createTestListing({ name: "Standard Member" });
    const daily = await createTestListing({
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Daily Member",
    });

    expect(await assignListingsToGroup([standard.id, daily.id], group.id)).toBe(
      t("error.group_listing_type_mismatch", { type: "standard" }),
    );
    expect(await listingGroupIdsOf(standard.id)).toEqual([]);
    expect(await listingGroupIdsOf(daily.id)).toEqual([]);
  });

  test("adding no listings touches nothing", async () => {
    const group = await createTestGroup({ name: "Bulk Empty Group" });
    const listing = await createTestListing({ name: "Bulk Untouched" });

    await assignListingsToGroup([], group.id);

    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
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
    expect(await listingGroupIdsOf(payMore.id)).toEqual([]);
    expect(await listingGroupIdsOf(addOn.id)).toEqual([]);
  });

  test("a hidden package refuses a member that offers add-ons", async () => {
    const group = await createHiddenPackageGroup("Hidden Package Rules");
    const parent = await createTestListing({ name: "Hidden Package Parent" });
    const child = await createTestListing({ name: "Hidden Package Child" });
    await listingChildren.setIds(parent.id, [child.id]);

    expect(await assignListingsToGroup([parent.id], group.id)).toBe(
      t("error.package_member_gates_children_hidden", { name: parent.name }),
    );
    expect(await listingGroupIdsOf(parent.id)).toEqual([]);
  });

  test("a customisable-days group refuses a fixed-length listing", async () => {
    const group = await createTestGroup({ name: "Customisable Length Group" });
    const customisable = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      name: "Customisable Member",
    });
    const fixed = await createTestListing({ name: "Fixed Member" });

    expect(await assignListingsToGroup([customisable.id], group.id)).toBeNull();
    expect(await assignListingsToGroup([fixed.id], group.id)).toBe(
      t("error.group_customisable_days_expected"),
    );
    expect(await listingGroupIdsOf(fixed.id)).toEqual([]);
  });

  test("a fixed-length group refuses a customisable-days listing", async () => {
    const group = await createTestGroup({ name: "Fixed Length Group" });
    const fixed = await createTestListing({ name: "Fixed Member" });
    const customisable = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      name: "Customisable Member",
    });

    expect(await assignListingsToGroup([fixed.id], group.id)).toBeNull();
    expect(await assignListingsToGroup([customisable.id], group.id)).toBe(
      t("error.group_customisable_days_unexpected"),
    );
    expect(await listingGroupIdsOf(customisable.id)).toEqual([]);
  });

  test("adding to a deleted group reports the missing group", async () => {
    const listing = await createTestListing({ name: "Missing Group Member" });

    expect(await assignListingsToGroup([listing.id], 999_999)).toBe(
      t("error.selected_group_deleted"),
    );
    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
  });
});
