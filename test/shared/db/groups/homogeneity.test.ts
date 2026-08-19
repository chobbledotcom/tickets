/** Direct tests for homogeneity.ts — the group listing type and
 *  customisable-days checks that keep a group's members interchangeable. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkGroupListingSettings } from "#db/groups/homogeneity.ts";
import { getListingsByGroupId } from "#db/groups.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > group listing homogeneity", { db: true }, () => {
  test("a fixed candidate is rejected by a customisable group", async () => {
    const customGroup = await createTestGroup({ name: "Custom Group" });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
      groupId: customGroup.id,
      name: "Custom Member",
    });
    const customMembers = await getListingsByGroupId(customGroup.id);
    expect(
      checkGroupListingSettings(customMembers, (members) => members, {
        customisable_days: false,
        id: 0,
        listing_type: "standard",
      }),
    ).toEqual({
      error: t("error.group_customisable_days_expected"),
      group: null,
      ok: false,
    });
  });

  test("a customisable candidate is rejected by a fixed group", async () => {
    const fixedGroup = await createTestGroup({ name: "Fixed Group" });
    await createTestListing({ groupId: fixedGroup.id, name: "Fixed Member" });
    const fixedMembers = await getListingsByGroupId(fixedGroup.id);
    expect(
      checkGroupListingSettings(fixedMembers, (members) => members, {
        customisable_days: true,
        id: 0,
        listing_type: "standard",
      }),
    ).toEqual({
      error: t("error.group_customisable_days_unexpected"),
      group: null,
      ok: false,
    });
  });

  test("a type mismatch names the type already in the group", async () => {
    const group = await createTestGroup({ name: "Daily Type Group" });
    await createTestListing({
      groupId: group.id,
      listingType: "daily",
      name: "Daily Type Member",
    });

    expect(
      checkGroupListingSettings(
        await getListingsByGroupId(group.id),
        (members) => members,
        { customisable_days: false, id: 0, listing_type: "standard" },
      ),
    ).toEqual({
      error: t("error.group_listing_type_mismatch", { type: "daily" }),
      group: null,
      ok: false,
    });
  });

  test("matching customisable-day settings are accepted", async () => {
    const group = await createTestGroup({ name: "Matching Custom Group" });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
      groupId: group.id,
      name: "Matching Custom Member",
    });

    const members = await getListingsByGroupId(group.id);
    expect(
      checkGroupListingSettings(members, (rows) => rows, {
        customisable_days: true,
        id: 0,
        listing_type: "standard",
      }),
    ).toEqual({
      group: members,
      ok: true,
    });
  });
});
