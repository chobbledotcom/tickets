/** Adding listings to a group from the admin page. */

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingsByGroupId } from "#db/groups.ts";
import { t } from "#i18n";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** POST the add-listings form for `groupId` and return the raw response. */
const addListings = async (
  groupId: number,
  listingIds: readonly number[],
): Promise<Response> =>
  (
    await adminFormPost(`/admin/groups/${groupId}/add-listings`, {
      listing_ids: listingIds.map(String),
    })
  ).response;

const expectRejectedListingBatch = async (
  groupId: number,
  listingIds: number[],
  message: string,
): Promise<void> => {
  const response = await addListings(groupId, listingIds);
  expectFlash(response, message, false);
  // A refused batch must not add its first listing before it notices the next.
  expect(await getListingsByGroupId(groupId)).toEqual([]);
};

/** A daily listing — the type a standard group refuses. */
const createDailyOutsider = (name: string) =>
  createTestListing({
    listingType: "daily",
    maximumDaysAfter: 30,
    minimumDaysBefore: 0,
    name,
  });

/** A customisable-days listing — the shape a fixed-length group refuses. */
const createCustomisableOutsider = (name: string) =>
  createTestListing({ customisableDays: true, dayPrices: { 1: 100 }, name });

describeWithEnv("admin group listing assignment", { db: true }, () => {
  test("adds the chosen listings to the group", async () => {
    const group = await createTestGroup({ name: "Growing group" });
    const first = await createTestListing({ name: "First joiner" });
    const second = await createTestListing({ name: "Second joiner" });

    const response = await addListings(group.id, [first.id, second.id]);
    expectFlash(response, t("success.listings_added_to_group"));
    expect(
      (await getListingsByGroupId(group.id)).map((l) => l.id).toSorted(),
    ).toEqual([first.id, second.id].toSorted());
  });

  test("refuses a listing whose type differs from the group's", async () => {
    const group = await createTestGroup({ name: "Standard group" });
    await createTestListing({ groupId: group.id, name: "Standard member" });
    const daily = await createDailyOutsider("Daily outsider");

    const response = await addListings(group.id, [daily.id]);
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
    const daily = await createDailyOutsider("Daily outsider");

    await expectRejectedListingBatch(
      group.id,
      [standard.id, daily.id],
      t("error.group_listing_type_mismatch", { type: "standard" }),
    );
  });

  test("refuses mixed customisable-days settings added together to an empty group", async () => {
    const group = await createTestGroup({ name: "Empty group" });
    const fixed = await createTestListing({ name: "Fixed outsider" });
    const customisable = await createCustomisableOutsider(
      "Customisable outsider",
    );

    await expectRejectedListingBatch(
      group.id,
      [fixed.id, customisable.id],
      t("error.group_customisable_days_unexpected"),
    );
  });

  test("concurrent incompatible additions leave one group member", async () => {
    const group = await createTestGroup({ name: "Concurrent group" });
    const standard = await createTestListing({ name: "Standard outsider" });
    const daily = await createDailyOutsider("Daily outsider");

    await Promise.all([
      addListings(group.id, [standard.id]),
      addListings(group.id, [daily.id]),
    ]);

    const memberIds = (await getListingsByGroupId(group.id)).map(
      (listing) => listing.id,
    );
    expect(memberIds).toHaveLength(1);
    assertArrayIncludes([standard.id, daily.id], [memberIds[0]]);
  });

  test("refuses a listing whose customisable-days setting differs from the group's", async () => {
    const group = await createTestGroup({ name: "Fixed Length Group" });
    const fixed = await createTestListing({
      groupId: group.id,
      name: "Fixed member",
    });
    const customisable = await createCustomisableOutsider(
      "Customisable outsider",
    );

    const response = await addListings(group.id, [customisable.id]);
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

    const response = await addListings(group.id, [donation.id]);

    expectFlash(
      response,
      t("error.package_member_pay_more", { name: donation.name }),
      false,
    );
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });

  test("adds nothing when no listing was chosen", async () => {
    const group = await createTestGroup({ name: "Untouched group" });

    const response = await addListings(group.id, []);
    expectFlash(response, t("success.listings_added_to_group"));
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });

  test("ignores a listing id that names nothing", async () => {
    const group = await createTestGroup({ name: "Ghost group" });

    await addListings(group.id, [0, 999_999]);
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });
});
