/** Adding listings to a group from the admin page. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { getListingsByGroupId } from "#shared/db/groups.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminPost } from "./helpers.ts";

const expectRejectedListingBatch = async (
  groupId: number,
  listingIds: number[],
  message: string,
): Promise<void> => {
  const response = await adminPost(`/admin/groups/${groupId}/add-listings`, {
    listing_ids: listingIds.map(String),
  });
  expectFlash(response, message, false);
  // A refused batch must not add its first listing before it notices the next.
  expect(await getListingsByGroupId(groupId)).toEqual([]);
};

describeWithEnv("admin group listing assignment", { db: true }, () => {
  test("adds the chosen listings to the group", async () => {
    const group = await createTestGroup({ name: "Growing group" });
    const first = await createTestListing({ name: "First joiner" });
    const second = await createTestListing({ name: "Second joiner" });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [String(first.id), String(second.id)],
    });
    expectFlash(response, t("success.listings_added_to_group"));
    expect(
      (await getListingsByGroupId(group.id)).map((l) => l.id).toSorted(),
    ).toEqual([first.id, second.id].toSorted());
  });

  test("refuses a listing whose type differs from the group's", async () => {
    const group = await createTestGroup({ name: "Standard group" });
    await createTestListing({ groupId: group.id, name: "Standard member" });
    const daily = await createTestListing({
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Daily outsider",
    });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [String(daily.id)],
    });
    expectFlash(
      response,
      t("error.group_listing_type_mismatch", { type: "standard" }),
      false,
    );
    // A refusal keeps the operator on the group they were adding to.
    expectRedirect(response, new RegExp(`^/admin/groups/${group.id}\\?flash=`));
    expect(await getListingsByGroupId(group.id)).toHaveLength(1);
  });

  test("refuses mixed listing types added together to an empty group", async () => {
    const group = await createTestGroup({ name: "Empty group" });
    const standard = await createTestListing({ name: "Standard outsider" });
    const daily = await createTestListing({
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Daily outsider",
    });

    await expectRejectedListingBatch(
      group.id,
      [standard.id, daily.id],
      t("error.group_listing_type_mismatch", { type: "standard" }),
    );
  });

  test("refuses mixed customisable-days settings added together to an empty group", async () => {
    const group = await createTestGroup({ name: "Empty group" });
    const fixed = await createTestListing({ name: "Fixed outsider" });
    const customisable = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      name: "Customisable outsider",
    });

    await expectRejectedListingBatch(
      group.id,
      [fixed.id, customisable.id],
      t("error.group_customisable_days_unexpected"),
    );
  });

  test("concurrent incompatible additions leave one group member", async () => {
    const group = await createTestGroup({ name: "Concurrent group" });
    const standard = await createTestListing({ name: "Standard outsider" });
    const daily = await createTestListing({
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Daily outsider",
    });

    await Promise.all([
      adminPost(`/admin/groups/${group.id}/add-listings`, {
        listing_ids: [String(standard.id)],
      }),
      adminPost(`/admin/groups/${group.id}/add-listings`, {
        listing_ids: [String(daily.id)],
      }),
    ]);

    const memberIds = (await getListingsByGroupId(group.id)).map(
      (listing) => listing.id,
    );
    expect(memberIds).toHaveLength(1);
    expect([standard.id, daily.id]).toContain(memberIds[0]);
  });

  test("refuses a listing whose customisable-days setting differs from the group's", async () => {
    const group = await createTestGroup({ name: "Fixed Length Group" });
    const fixed = await createTestListing({
      groupId: group.id,
      name: "Fixed member",
    });
    const customisable = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      name: "Customisable outsider",
    });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [String(customisable.id)],
    });
    expectFlash(response, t("error.group_customisable_days_unexpected"), false);
    // Not just the same count: the group still holds exactly the member it had.
    expect(
      (await getListingsByGroupId(group.id)).map((listing) => listing.id),
    ).toEqual([fixed.id]);
  });

  test("marks an unpackageable listing refusal as an error", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Package group",
    });
    const donation = await createTestListing({
      canPayMore: true,
      name: "Donation",
    });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [String(donation.id)],
    });

    expectFlash(
      response,
      t("error.package_member_pay_more", { name: donation.name }),
      false,
    );
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });

  test("adds nothing when no listing was chosen", async () => {
    const group = await createTestGroup({ name: "Untouched group" });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [],
    });
    expectFlash(response, t("success.listings_added_to_group"));
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });

  test("ignores a listing id that names nothing", async () => {
    const group = await createTestGroup({ name: "Ghost group" });

    await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: ["0", "999999"],
    });
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });
});
