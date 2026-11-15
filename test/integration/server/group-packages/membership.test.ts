/**
 * What may and may not be sold as part of a package, whichever door it comes
 * in by: the group's own form, its add-listings form, the listings API, and the
 * children sub-form. A package cannot hold a thing whose price is not settled,
 * nor a thing that is already part of something else.
 *
 * Sits beside the story `@story:bookings.selling-things-as-one-bundle`: these
 * own the branch cover, and the invariants that have no journey behind them.
 */

import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices, groups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import { assertJson, expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeParent } from "#test-utils/parents.ts";
import { adminFormPost, apiRequest } from "#test-utils/session.ts";
import {
  editFields,
  expectAddListingRejected,
  expectPackageAccepted,
  expectPackageRefused,
  expectPackageRejected,
  member,
} from "./helpers.ts";

/** A visible package group — the starting shape of most of these tests. */
const packageGroup = (name: string, slug: string) =>
  createTestGroup({ isPackage: true, name, slug });

/** POST the children sub-form for `parentId` and return the raw response. */
const postChildrenForm = async (
  parentId: number,
  childId: number,
): Promise<Response> =>
  (
    await adminFormPost(`/admin/listing/${parentId}/children`, {
      child_listing_ids: String(childId),
    })
  ).response;

/** Hide the members' names inside `groupId`, so a member that gates children
 *  would leak them. */
const hidePackageNames = async (groupId: number): Promise<void> => {
  await groups.table.update(groupId, { hidePackageListings: true });
};

/** Write a listing through the JSON API and assert the 400 error it names.
 *  The package rules carry the offending listing's name, so the caller states
 *  the exact message. */
const expectApiRefused = async (
  path: string,
  body: Record<string, unknown>,
  message: string,
  method: "POST" | "PUT" = "POST",
): Promise<void> => {
  await assertJson(apiRequest(path, { body, method }), 400, (json) => {
    expect(json.error).toBe(message);
  });
};

describeWithEnv(
  "server (admin group packages) — what may join a package",
  { db: true },
  () => {
    test("edit POST accepts is_package on a group with a daily listing", async () => {
      // Daily members are packageable: the bundle books every member from one
      // shared date selector (the group invariant keeps members homogeneous).
      const group = await createTestGroup({ name: "Daily", slug: "daily-pkg" });
      await member(group, "Daily Member", {
        date: "2026-09-01T10:00",
        listingType: "daily",
      });
      await expectPackageAccepted(group);
    });

    test("edit POST accepts is_package with a parent member, but not hidden", async () => {
      const group = await createTestGroup({
        name: "ParentG",
        slug: "parent-g",
      });
      const parent = await member(group, "Parent Member");
      const child = await createTestListing({ name: "Child Of Parent" });
      await listingChildren.setIds(parent.id, [child.id]);
      // A VISIBLE package renders the member's child selector, so a parent
      // member is fine…
      await expectPackageAccepted(group);
      // …but hiding the package would collapse members to the package name, so a
      // child selector would leak them — the hide save is rejected.
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/edit`,
        {
          ...editFields(group.name, group.slug),
          hide_package_listings: "1",
          is_package: "1",
        },
      );
      const refused = await expectPackageRefused(group, response);
      expect(refused.hide_package_listings).toBe(false);
    });

    test("edit POST rejects is_package on a group whose member is another listing's child", async () => {
      const group = await createTestGroup({ name: "ChildG", slug: "child-g" });
      const childMember = await member(group, "Child Member");
      const parent = await createTestListing({ name: "Outside Gate" });
      await listingChildren.setIds(parent.id, [childMember.id]);
      // A package member is only ever sold as part of its bundle, so a listing
      // folded under another parent can't be packaged — visible or not.
      await expectPackageRejected(group);
    });

    test("add-listings rejects a child listing into a package group", async () => {
      const group = await packageGroup("PkgChild", "pkg-child");
      const { child } = await makeParent({
        children: [{ name: "Child Add" }],
        parent: { name: "Outside Parent" },
      });

      await expectAddListingRejected(group, child.id);
    });

    test("the listings API rejects a pay-what-you-want listing joining a package group", async () => {
      const group = await packageGroup("ApiPkg", "api-pkg");
      await expectApiRefused(
        "/api/admin/listings",
        {
          can_pay_more: true,
          group_ids: [group.id],
          max_attendees: 10,
          max_price: 10000,
          name: "Pay In Package",
        },
        t("error.package_member_pay_more", { name: "Pay In Package" }),
      );
    });

    test("the listings API lets a parent join a visible package but not a hidden one", async () => {
      const { child, parent } = await makeParent({
        children: [{ name: "Child List" }],
        parent: { name: "Parent List" },
      });

      // A visible package renders the member's child selector, so the parent
      // joins with its gate intact.
      const visible = await packageGroup("ParentApiPkg", "parent-api-pkg");
      await assertJson(
        apiRequest(`/api/admin/listings/${parent.id}`, {
          body: { group_ids: [visible.id] },
          method: "PUT",
        }),
        200,
      );
      expect(await listingChildren.getIds(parent.id)).toEqual([child.id]);

      // A hidden package collapses members to the package name, so a member's
      // child selector would leak them — the join is rejected.
      const hidden = await packageGroup("HiddenApiPkg", "hidden-api-pkg");
      await hidePackageNames(hidden.id);
      await expectApiRefused(
        `/api/admin/listings/${parent.id}`,
        { group_ids: [hidden.id] },
        t("error.package_member_gates_children_hidden", {
          name: "Parent List",
        }),
        "PUT",
      );
    });

    test("the listings API accepts a plain standard listing joining a package group", async () => {
      const group = await packageGroup("OkApiPkg", "ok-api-pkg");
      const listing = await createTestListing({ name: "Plain List" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { group_ids: [group.id] },
          method: "PUT",
        }),
        200,
      );
    });

    test("the listings API accepts new child edges into a visible package but not a hidden one", async () => {
      const child = await createTestListing({ name: "Edge Child" });

      const visible = await packageGroup("ChildEdgePkg", "child-edge-pkg");
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            child_listing_ids: [child.id],
            group_ids: [visible.id],
            max_attendees: 10,
            name: "New Parent In Package",
          },
          method: "POST",
        }),
        201,
      );

      const hidden = await packageGroup("HiddenEdgePkg", "hidden-edge-pkg");
      await hidePackageNames(hidden.id);
      await expectApiRefused(
        "/api/admin/listings",
        {
          child_listing_ids: [child.id],
          group_ids: [hidden.id],
          max_attendees: 10,
          name: "New Parent In Hidden Package",
        },
        t("error.package_gate_in_hidden"),
      );
    });

    test("the listings API rejects choosing a package member as a child", async () => {
      const group = await packageGroup("MemberChildPkg", "member-child-pkg");
      const memberListing = await member(group, "Pkg Member");

      await expectApiRefused(
        "/api/admin/listings",
        {
          child_listing_ids: [memberListing.id],
          max_attendees: 10,
          name: "Parent Of Member",
        },
        t("error.package_child_is_member"),
      );
    });

    test("the children sub-form rejects choosing a package member as a child", async () => {
      const group = await packageGroup("MemberChildForm", "member-child-form");
      const memberListing = await member(group, "Form Member");
      const parent = await createTestListing({ name: "Form Parent" });

      const response = await postChildrenForm(parent.id, memberListing.id);
      await expectFlashRedirect(
        `/admin/listing/${parent.id}/edit`,
        t("error.package_child_is_member"),
        false,
      )(response);
      expect(await listingChildren.getIds(parent.id)).toEqual([]);
    });

    test("the children sub-form lets a visible package's member gain children, but not a hidden one's", async () => {
      const group = await packageGroup("ChildFormPkg", "child-form-pkg");
      const memberListing = await member(group, "Pkg Member");
      const child = await createTestListing({ name: "Would-be Child" });

      // Visible package: the member's child gate saves and the package page can
      // render its selector.
      const accepted = await postChildrenForm(memberListing.id, child.id);
      expect(accepted.status).toBe(302);
      expect(await listingChildren.getIds(memberListing.id)).toEqual([
        child.id,
      ]);
      await listingChildren.setIds(memberListing.id, []);

      // Hidden package: the same edge would leak the collapsed member.
      await hidePackageNames(group.id);
      const response = await postChildrenForm(memberListing.id, child.id);
      await expectFlashRedirect(
        `/admin/listing/${memberListing.id}/edit`,
        t("error.package_gate_in_hidden"),
        false,
      )(response);
      expect(await listingChildren.getIds(memberListing.id)).toEqual([]);
    });

    test("edit POST accepts is_package on a group with a customisable-days listing", async () => {
      const group = await createTestGroup({ name: "Cust", slug: "cust" });
      await member(group, "Flexible", {
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
      });
      await expectPackageAccepted(group);
    });

    test("edit POST rejects is_package on a group with a pay-what-you-want listing", async () => {
      const group = await createTestGroup({ name: "Pay", slug: "pay" });
      await member(group, "Donate", { canPayMore: true });
      await expectPackageRejected(group);
    });

    test("add-listings rejects a pay-what-you-want listing", async () => {
      // The one remaining type restriction: a package needs an operator-set
      // price per member, so buyer-priced listings can't join.
      const group = await packageGroup("PkgAdd", "pkg-add");
      const donate = await createTestListing({
        canPayMore: true,
        name: "Donate Add",
      });

      await expectAddListingRejected(group, donate.id);
    });

    test("add-listings accepts a customisable-days listing into a package group", async () => {
      const group = await packageGroup("PkgFlex", "pkg-flex");
      const flexible = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
        name: "Flex Add",
      });
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/add-listings`,
        { listing_ids: String(flexible.id) },
      );
      expect(response.status).toBe(302);
      const prices = await getGroupPackagePrices(group.id);
      assertArrayIncludes(
        prices.map((r) => r.listing_id),
        [flexible.id],
      );
    });

    test("add-listings accepts a fixed-price listing into a package group", async () => {
      const group = await packageGroup("PkgOk", "pkg-ok");
      const fixed = await createTestListing({ name: "Fixed Add" });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/add-listings`,
        { listing_ids: String(fixed.id) },
      );
      expect(response.status).toBe(302);
      const rows = await getGroupPackagePrices(group.id);
      expect(rows.map((r) => r.listing_id)).toEqual([fixed.id]);
    });
  },
);
