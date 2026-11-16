/** Direct tests for homogeneity.ts — the group listing type and
 *  customisable-days checks that keep a group's members interchangeable. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkGroupListingSettings,
  groupCandidateBlockedError,
} from "#db/groups/homogeneity.ts";
import { getListingsByGroupId } from "#db/groups.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createGroupWithListings,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
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
        customisableDays: false,
        id: 0,
        listingType: "standard",
      }),
    ).toEqual({
      error: t("error.group_customisable_days_expected"),
      group: null,
      ok: false,
    });
  });

  test("a customisable candidate is rejected by a fixed group", async () => {
    const { group } = await createGroupWithListings("Fixed Group", [
      "Fixed Member",
    ]);
    const fixedMembers = await getListingsByGroupId(group.id);
    expect(
      checkGroupListingSettings(fixedMembers, (members) => members, {
        customisableDays: true,
        id: 0,
        listingType: "standard",
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
        { customisableDays: false, id: 0, listingType: "standard" },
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
        customisableDays: true,
        id: 0,
        listingType: "standard",
      }),
    ).toEqual({
      group: members,
      ok: true,
    });
  });

  test("a matching candidate carries no why", () => {
    const members = [
      { customisableDays: true, id: 1, listingType: "standard" as const },
    ];
    expect(
      groupCandidateBlockedError(members, {
        customisableDays: true,
        id: 9,
        listingType: "standard",
      }),
    ).toBeNull();
  });

  test("a customisable-days clash says which way the candidates differ", () => {
    const pickWhy = (memberDays: boolean, candidateDays: boolean): string =>
      groupCandidateBlockedError(
        [{ customisableDays: memberDays, id: 1, listingType: "standard" }],
        { customisableDays: candidateDays, id: 9, listingType: "standard" },
      )!;

    expect(pickWhy(false, true)).toBe(t("groups.candidate_days_blocked_fixed"));
    expect(pickWhy(true, false)).toBe(
      t("groups.candidate_days_blocked_customisable"),
    );
  });

  test("a type clash names the candidate's type and the group's", () => {
    expect(
      groupCandidateBlockedError(
        [{ customisableDays: false, id: 1, listingType: "standard" }],
        { customisableDays: false, id: 9, listingType: "daily" },
      ),
    ).toBe(
      t("groups.candidate_type_blocked", {
        candidate: "daily",
        type: "standard",
      }),
    );
  });

  test("a listing rejected for a group that is gone names the deleted group", () => {
    expect(
      checkGroupListingSettings<IllListed>(
        undefined,
        (members) => members ?? [],
        {
          customisableDays: false,
          id: 9,
          listingType: "daily",
        },
      ),
    ).toEqual({
      error: t("error.selected_group_deleted"),
      group: null,
      ok: false,
    });
  });
});

type IllListed = readonly {
  customisableDays: boolean;
  id: number;
  listingType: "daily";
}[];
