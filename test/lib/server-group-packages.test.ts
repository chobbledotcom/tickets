import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getAllGroups,
  getGroupPackagePrices,
  groupsTable,
} from "#shared/db/groups.ts";
import { getChildIds, setChildIds } from "#shared/db/listing-parents.ts";
import {
  adminFormPost,
  adminGet,
  apiRequest,
  assertJson,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  getTestPackagePrices,
} from "#test-utils";

/** Base fields the group edit form always submits. */
const editFields = (name: string, slug: string) => ({
  description: "",
  max_attendees: "0",
  name,
  slug,
  terms_and_conditions: "",
});

/** Create a listing that belongs to `group`. */
const member = (
  group: { id: number },
  name: string,
  extra: Record<string, unknown> = {},
) => createTestListing({ groupId: group.id, name, ...extra });

/** POST the edit form with is_package ticked and assert it was rejected by the
 * package invariant, leaving the flag clear. */
const expectPackageRejected = async (group: {
  id: number;
  name: string;
  slug: string;
}): Promise<void> => {
  const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
    ...editFields(group.name, group.slug),
    is_package: "1",
  });
  await expectFlashRedirect(
    `/admin/groups/${group.id}/edit`,
    expect.stringContaining("Packages cannot contain"),
    false,
  )(response);
  expect((await groupsTable.findById(group.id))!.is_package).toBe(false);
};

/** POST add-listings with `listingId` to a package group and assert the package
 * invariant rejected it, leaving the group with no priced members. */
const expectAddListingRejected = async (
  group: { id: number },
  listingId: number,
): Promise<void> => {
  const { response } = await adminFormPost(
    `/admin/groups/${group.id}/add-listings`,
    { listing_ids: String(listingId) },
  );
  await expectFlashRedirect(
    `/admin/groups/${group.id}`,
    expect.stringContaining("Packages cannot contain"),
    false,
  )(response);
  expect(await getGroupPackagePrices(group.id)).toEqual([]);
};

describeWithEnv("server (admin group packages)", { db: true }, () => {
  test("create POST persists the is_package flag", async () => {
    const { response } = await adminFormPost("/admin/groups", {
      is_package: "1",
      max_attendees: "0",
      name: "Bundle",
      terms_and_conditions: "",
    });
    expect(response.status).toBe(302);
    const groups = await getAllGroups();
    expect(groups[groups.length - 1]!.is_package).toBe(true);
  });

  test("edit POST saves is_package, per-listing prices and quantities", async () => {
    const group = await createTestGroup({ name: "Pkg", slug: "pkg" });
    const a = await member(group, "A");
    const b = await member(group, "B");

    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Pkg", "pkg"),
      is_package: "1",
      [`package_price_${a.id}`]: "12.50",
      [`package_price_${b.id}`]: "",
      [`package_qty_${a.id}`]: "2",
      // b omits package_qty → defaults to 1.
    });
    await expectFlashRedirect(
      `/admin/groups/${group.id}`,
      "Group updated",
      true,
    )(response);

    const saved = (await groupsTable.findById(group.id))!;
    expect(saved.is_package).toBe(true);
    const prices = await getTestPackagePrices(group.id);
    expect(prices.get(a.id)).toBe(1250);
    // Blank input is stored as 0 (no override), so it's absent from the map.
    expect(prices.has(b.id)).toBe(false);
    const rows = await getGroupPackagePrices(group.id);
    const qty = new Map(rows.map((r) => [r.listing_id, r.quantity]));
    expect(qty.get(a.id)).toBe(2);
    expect(qty.get(b.id)).toBe(1);
  });

  test("edit POST defaults a malformed or out-of-range quantity to 1", async () => {
    const group = await createTestGroup({ name: "BadQty", slug: "bad-qty" });
    const prefix = await member(group, "Prefix");
    const zero = await member(group, "Zero");
    const huge = await member(group, "Huge");

    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("BadQty", "bad-qty"),
      is_package: "1",
      [`package_price_${prefix.id}`]: "1.00",
      [`package_price_${zero.id}`]: "1.00",
      [`package_price_${huge.id}`]: "1.00",
      // parseInt would read 2 from "2abc"; 0 is below the minimum; the 20-digit
      // value overflows the safe-integer range — each defaults to 1.
      [`package_qty_${prefix.id}`]: "2abc",
      [`package_qty_${zero.id}`]: "0",
      [`package_qty_${huge.id}`]: "99999999999999999999",
    });

    const rows = await getGroupPackagePrices(group.id);
    const qty = new Map(rows.map((r) => [r.listing_id, r.quantity]));
    expect(qty.get(prefix.id)).toBe(1);
    expect(qty.get(zero.id)).toBe(1);
    expect(qty.get(huge.id)).toBe(1);
  });

  test("edit POST persists the hide-package-listings flag", async () => {
    const group = await createTestGroup({ name: "HideG", slug: "hide-g" });
    await member(group, "HM");

    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("HideG", "hide-g"),
      hide_package_listings: "1",
      is_package: "1",
    });
    expect((await groupsTable.findById(group.id))!.hide_package_listings).toBe(
      true,
    );
  });

  test("the hidden package booking page does not expose its single member", async () => {
    const { handleRequest } = await import("#routes");
    const { mockRequest } = await import("#test-utils/mocks.ts");
    const group = await createTestGroup({
      isPackage: true,
      name: "HiddenPage",
      slug: "hidden-page",
    });
    await groupsTable.update(group.id, { hidePackageListings: true });
    await member(group, "SecretMember", { location: "SecretVenue" });

    const body = await (
      await handleRequest(mockRequest(`/ticket/${group.slug}`))
    ).text();
    // The page renders (as a package), but the lone member's name/location are
    // not leaked in the header/OpenGraph (singleListing is dropped when hidden).
    expect(body).toContain("HiddenPage");
    expect(body).not.toContain("SecretMember");
    expect(body).not.toContain("SecretVenue");
  });

  test("a hidden package member's own /ticket slug 404s, never a standalone page", async () => {
    const { handleRequest } = await import("#routes");
    const { mockRequest } = await import("#test-utils/mocks.ts");
    const group = await createTestGroup({
      isPackage: true,
      name: "DirectHide",
      slug: "direct-hide",
    });
    await groupsTable.update(group.id, { hidePackageListings: true });
    const listing = await member(group, "DirectMember");

    // Only the package (group slug) is public; the member's own slug must not
    // resolve to a standalone booking page.
    const res = await handleRequest(mockRequest(`/ticket/${listing.slug}`));
    expect(res.status).toBe(404);
  });

  test("edit POST rejects is_package on a group with a daily listing", async () => {
    const group = await createTestGroup({ name: "Daily", slug: "daily-pkg" });
    await member(group, "Daily Member", {
      date: "2026-09-01T10:00",
      listingType: "daily",
    });
    await expectPackageRejected(group);
  });

  test("edit POST rejects is_package on a group with a parent listing", async () => {
    const group = await createTestGroup({ name: "ParentG", slug: "parent-g" });
    const parent = await member(group, "Parent Member");
    const child = await createTestListing({ name: "Child Of Parent" });
    await setChildIds(parent.id, [child.id]);
    // A parent's per-child selectors can't render on a package page, so it
    // can't be packaged.
    await expectPackageRejected(group);
  });

  test("add-listings rejects a child listing into a package group", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "PkgChild",
      slug: "pkg-child",
    });
    const parent = await createTestListing({ name: "Outside Parent" });
    const child = await createTestListing({ name: "Child Add" });
    await setChildIds(parent.id, [child.id]);

    await expectAddListingRejected(group, child.id);
  });

  test("edit POST treats a negative or non-numeric package price as no override", async () => {
    const group = await createTestGroup({ name: "Bad", slug: "bad" });
    const a = await member(group, "Neg");
    const b = await member(group, "NaN");

    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Bad", "bad"),
      is_package: "1",
      [`package_price_${a.id}`]: "-5",
      [`package_price_${b.id}`]: "abc",
    });
    expect(response.status).toBe(302);
    // Both invalid inputs store 0 (no override), so neither appears in the map.
    expect((await getTestPackagePrices(group.id)).size).toBe(0);
  });

  test("edit POST rejects a leading-numeric typo instead of parsing a prefix", async () => {
    const group = await createTestGroup({ name: "Typo", slug: "typo" });
    const a = await member(group, "Letters");
    const b = await member(group, "Comma");

    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Typo", "typo"),
      is_package: "1",
      // parseFloat would turn these into a real 12 / 1 override; the strict
      // parser treats the whole non-numeric string as "no override" (0).
      [`package_price_${a.id}`]: "12abc",
      [`package_price_${b.id}`]: "1,50",
    });
    expect(response.status).toBe(302);
    expect((await getTestPackagePrices(group.id)).size).toBe(0);
  });

  test("edit POST rejects an out-of-range package price as no override", async () => {
    const group = await createTestGroup({ name: "Huge", slug: "huge" });
    const a = await member(group, "Big");

    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Huge", "huge"),
      is_package: "1",
      // 14 nines scales past Number.MAX_SAFE_INTEGER in minor units, so it would
      // store a lossy amount — rejected to 0 (no override) instead.
      [`package_price_${a.id}`]: "99999999999999",
    });
    expect(response.status).toBe(302);
    expect((await getTestPackagePrices(group.id)).size).toBe(0);
  });

  test("the listings API rejects a pay-what-you-want listing joining a package group", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "ApiPkg",
      slug: "api-pkg",
    });
    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          can_pay_more: true,
          group_ids: [group.id],
          max_attendees: 10,
          max_price: 10000,
          name: "Pay In Package",
        },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toContain("Packages cannot contain");
      },
    );
  });

  test("the listings API rejects a parent listing joining a package group", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "ParentApiPkg",
      slug: "parent-api-pkg",
    });
    const parent = await createTestListing({ name: "Parent List" });
    const child = await createTestListing({ name: "Child List" });
    await setChildIds(parent.id, [child.id]);

    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { group_ids: [group.id] },
        method: "PUT",
      }),
      400,
      (body) => {
        expect(body.error).toContain("Packages cannot contain");
      },
    );
  });

  test("the listings API accepts a plain standard listing joining a package group", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "OkApiPkg",
      slug: "ok-api-pkg",
    });
    const listing = await createTestListing({ name: "Plain List" });

    await assertJson(
      apiRequest(`/api/admin/listings/${listing.id}`, {
        body: { group_ids: [group.id] },
        method: "PUT",
      }),
      200,
    );
  });

  test("the listings API rejects new child edges when joining a package group", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "ChildEdgePkg",
      slug: "child-edge-pkg",
    });
    const child = await createTestListing({ name: "Edge Child" });

    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          child_listing_ids: [child.id],
          group_ids: [group.id],
          max_attendees: 10,
          name: "New Parent In Package",
        },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toContain("Packages cannot contain");
      },
    );
  });

  test("the listings API rejects choosing a package member as a child", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "MemberChildPkg",
      slug: "member-child-pkg",
    });
    const memberListing = await member(group, "Pkg Member");

    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          child_listing_ids: [memberListing.id],
          max_attendees: 10,
          name: "Parent Of Member",
        },
        method: "POST",
      }),
      400,
      (body) => {
        expect(body.error).toContain("Packages cannot contain");
      },
    );
  });

  test("the children sub-form rejects choosing a package member as a child", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "MemberChildForm",
      slug: "member-child-form",
    });
    const memberListing = await member(group, "Form Member");
    const parent = await createTestListing({ name: "Form Parent" });

    const { response } = await adminFormPost(
      `/admin/listing/${parent.id}/children`,
      { child_listing_ids: String(memberListing.id) },
    );
    await expectFlashRedirect(
      `/admin/listing/${parent.id}/edit`,
      expect.stringContaining("Packages cannot contain"),
      false,
    )(response);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("the children sub-form rejects giving children to a package member", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "ChildFormPkg",
      slug: "child-form-pkg",
    });
    const memberListing = await member(group, "Pkg Member");
    const child = await createTestListing({ name: "Would-be Child" });

    const { response } = await adminFormPost(
      `/admin/listing/${memberListing.id}/children`,
      { child_listing_ids: String(child.id) },
    );
    await expectFlashRedirect(
      `/admin/listing/${memberListing.id}/edit`,
      expect.stringContaining("Packages cannot contain"),
      false,
    )(response);
    expect(await getChildIds(memberListing.id)).toEqual([]);
  });

  test("edit POST without is_package clears the package flag and overrides", async () => {
    const group = await createTestGroup({ name: "Clr", slug: "clr" });
    const a = await member(group, "CA");

    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Clr", "clr"),
      is_package: "1",
      [`package_price_${a.id}`]: "9.00",
    });
    expect((await groupsTable.findById(group.id))!.is_package).toBe(true);

    // Re-submit without the checkbox: flag clears and overrides reset to 0.
    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Clr", "clr"),
      [`package_price_${a.id}`]: "9.00",
    });
    const saved = (await groupsTable.findById(group.id))!;
    expect(saved.is_package).toBe(false);
    expect((await getTestPackagePrices(group.id)).size).toBe(0);
  });

  test("edit POST rejects is_package on a group with a customisable-days listing", async () => {
    const group = await createTestGroup({ name: "Cust", slug: "cust" });
    await member(group, "Flexible", {
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
    });
    await expectPackageRejected(group);
  });

  test("edit POST rejects is_package on a group with a pay-what-you-want listing", async () => {
    const group = await createTestGroup({ name: "Pay", slug: "pay" });
    await member(group, "Donate", { canPayMore: true });
    await expectPackageRejected(group);
  });

  test("edit GET renders the package price table pre-filled from overrides", async () => {
    const group = await createTestGroup({ name: "Show", slug: "show" });
    const a = await member(group, "Shown A");
    // A second member with no override exercises the "blank input" branch.
    const b = await member(group, "Shown B");
    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Show", "show"),
      is_package: "1",
      [`package_price_${a.id}`]: "7.00",
      [`package_price_${b.id}`]: "",
      [`package_qty_${a.id}`]: "5",
    });

    const html = await expectHtmlResponse(
      await adminGet(`/admin/groups/${group.id}/edit`),
      200,
      "Package prices",
      "Shown A",
    );
    expect(html).toContain(`name="package_price_${a.id}"`);
    expect(html).toContain('value="7.00"');
    // The override-free member renders an empty value, falling back to base price.
    expect(html).toContain(`name="package_price_${b.id}"`);
    // Per-package quantity inputs render, pre-filled with the saved quantity.
    expect(html).toContain(`name="package_qty_${a.id}"`);
    expect(html).toContain('value="5"');
  });

  test("edit GET shows the empty-group prompt when there are no listings", async () => {
    const group = await createTestGroup({ name: "Empty", slug: "empty" });
    await expectHtmlResponse(
      await adminGet(`/admin/groups/${group.id}/edit`),
      200,
      "Add listings to this group to set their package prices.",
    );
  });

  test("add-listings rejects a listing that can't be packaged", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "PkgAdd",
      slug: "pkg-add",
    });
    const flexible = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      durationDays: 1,
      name: "Flex Add",
    });

    await expectAddListingRejected(group, flexible.id);
  });

  test("add-listings accepts a fixed-price listing into a package group", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "PkgOk",
      slug: "pkg-ok",
    });
    const fixed = await createTestListing({ name: "Fixed Add" });

    const { response } = await adminFormPost(
      `/admin/groups/${group.id}/add-listings`,
      { listing_ids: String(fixed.id) },
    );
    expect(response.status).toBe(302);
    const rows = await getGroupPackagePrices(group.id);
    expect(rows.map((r) => r.listing_id)).toEqual([fixed.id]);
  });
});
