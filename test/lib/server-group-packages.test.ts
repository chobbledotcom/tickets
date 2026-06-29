import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getAllGroups,
  getGroupPackagePrices,
  groupsTable,
} from "#shared/db/groups.ts";
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

  test("edit POST saves is_package and per-listing package prices", async () => {
    const group = await createTestGroup({ name: "Pkg", slug: "pkg" });
    const a = await member(group, "A");
    const b = await member(group, "B");

    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Pkg", "pkg"),
      is_package: "1",
      [`package_price_${a.id}`]: "12.50",
      [`package_price_${b.id}`]: "",
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

    const { response } = await adminFormPost(
      `/admin/groups/${group.id}/add-listings`,
      { listing_ids: String(flexible.id) },
    );
    await expectFlashRedirect(
      `/admin/groups/${group.id}`,
      expect.stringContaining("Packages cannot contain"),
      false,
    )(response);
    expect(await getGroupPackagePrices(group.id)).toEqual([]);
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
