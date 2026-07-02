import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import {
  assignListingsToGroup,
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
  deactivateTestListing,
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

/** Stamp one sold ticket against `groupId` (as a package checkout would). */
const sellPackageTicket = async (
  listingId: number,
  groupId: number,
): Promise<string> => {
  const result = await createAttendeeAtomic({
    bookings: [{ listingId, quantity: 1 }],
    email: "buyer@test.com",
    name: "Buyer",
    packageGroupId: groupId,
  });
  if (!result.success) throw new Error("package booking failed");
  return result.attendees[0]!.ticket_token;
};

/** A HIDDEN package, its sole member, and one sold ticket stamped with the
 * group id — the state whose deletion must un-group rather than destroy. */
const hiddenPackageWithBooking = async (name: string, slug: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  await groupsTable.update(group.id, { hidePackageListings: true });
  const memberListing = await member(group, `${name} Member`);
  const token = await sellPackageTicket(memberListing.id, group.id);
  return { group, memberListing, token };
};

/** POST the group edit form with is_package ticked, returning the response. */
const postIsPackage = (group: {
  id: number;
  name: string;
  slug: string;
}): Promise<{ response: Response }> =>
  adminFormPost(`/admin/groups/${group.id}/edit`, {
    ...editFields(group.name, group.slug),
    is_package: "1",
  });

/** POST the edit form with is_package ticked and assert it was rejected by the
 * package invariant, leaving the flag clear. */
const expectPackageRejected = async (group: {
  id: number;
  name: string;
  slug: string;
}): Promise<void> => {
  const { response } = await postIsPackage(group);
  await expectFlashRedirect(
    `/admin/groups/${group.id}/edit`,
    expect.stringContaining("Packages cannot contain"),
    false,
  )(response);
  expect((await groupsTable.findById(group.id))!.is_package).toBe(false);
};

/** POST the edit form with is_package ticked and assert it saved. */
const expectPackageAccepted = async (group: {
  id: number;
  name: string;
  slug: string;
}): Promise<void> => {
  const { response } = await postIsPackage(group);
  expect(response.status).toBe(302);
  expect((await groupsTable.findById(group.id))!.is_package).toBe(true);
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

  test("edit POST saves per-day prices for customisable members and the form round-trips them", async () => {
    const { getGroupDayPrices } = await import("#shared/db/listing-prices.ts");
    const group = await createTestGroup({ name: "DayPkg", slug: "day-pkg" });
    const flex = await member(group, "Flex", {
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 1800 },
      durationDays: 2,
      listingType: "daily",
      unitPrice: 1000,
    });
    const plain = await member(group, "Plain");

    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("DayPkg", "day-pkg"),
      is_package: "1",
      // 2-day span repriced; 1-day left blank ("use the listing's own price").
      [`package_day_price_${flex.id}_1`]: "",
      [`package_day_price_${flex.id}_2`]: "15.00",
      [`package_price_${flex.id}`]: "",
      [`package_price_${plain.id}`]: "",
    });

    const saved = await getGroupDayPrices(group.id);
    expect(saved.get(flex.id)?.get(2)).toBe(1500);
    expect(saved.get(flex.id)?.has(1)).toBe(false);
    expect(saved.has(plain.id)).toBe(false);

    // The edit page renders a per-day input per offered span for the
    // customisable member only, pre-filled with the saved override.
    const html = await expectHtmlResponse(
      await adminGet(`/admin/groups/${group.id}/edit`),
      200,
    );
    expect(html).toContain(`name="package_day_price_${flex.id}_1"`);
    expect(html).toContain(`name="package_day_price_${flex.id}_2"`);
    expect(html).toContain('value="15.00"');
    expect(html).not.toContain(`package_day_price_${plain.id}_`);

    // Re-saving without the day inputs clears the overrides (full replace).
    await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("DayPkg", "day-pkg"),
      is_package: "1",
      [`package_price_${flex.id}`]: "",
      [`package_price_${plain.id}`]: "",
    });
    expect((await getGroupDayPrices(group.id)).size).toBe(0);
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

  test("a hidden package member's QR and qr-book 404 like its page", async () => {
    const { handleRequest } = await import("#routes");
    const { mockRequest } = await import("#test-utils/mocks.ts");
    const group = await createTestGroup({
      isPackage: true,
      name: "QrHide",
      slug: "qr-hide",
    });
    await groupsTable.update(group.id, { hidePackageListings: true });
    const listing = await member(group, "QrMember");

    const qr = await handleRequest(mockRequest(`/ticket/${listing.slug}/qr`));
    expect(qr.status).toBe(404);
    // A validly-signed qr-book token for the member is still rejected — a
    // hidden member is never bookable on its own, even direct-to-checkout.
    const { buildQrBookPayload, signQrBookToken } = await import(
      "#shared/qr-token.ts"
    );
    const token = await signQrBookToken(
      listing.slug,
      buildQrBookPayload({ name: "Ada", value: 1000 }),
    );
    const qrBook = await handleRequest(
      mockRequest(
        `/ticket/${listing.slug}/qr-book?t=${encodeURIComponent(token)}`,
      ),
    );
    expect(qrBook.status).toBe(404);
  });

  test("a non-package group never exposes a hidden package's members", async () => {
    const { handleRequest } = await import("#routes");
    const { mockRequest } = await import("#test-utils/mocks.ts");
    const pkg = await createTestGroup({
      isPackage: true,
      name: "HidePkg",
      slug: "hide-pkg",
    });
    await groupsTable.update(pkg.id, { hidePackageListings: true });
    const regular = await createTestGroup({ name: "Regular", slug: "regular" });
    // A listing shared between the hidden package and a regular public group.
    await createTestListing({
      groupIds: [pkg.id, regular.id],
      name: "SharedMember",
    });

    // The regular group's page must not show the member; with no other member
    // it has nothing to book and 404s rather than leaking it.
    const res = await handleRequest(mockRequest(`/ticket/${regular.slug}`));
    expect(res.status).toBe(404);
  });

  test("a direct /ticket/<package> URL 404s once a member is deactivated", async () => {
    const { handleRequest } = await import("#routes");
    const { mockRequest } = await import("#test-utils/mocks.ts");
    const group = await createTestGroup({
      isPackage: true,
      name: "Bundle",
      slug: "bundle",
    });
    await member(group, "First");
    const second = await member(group, "Second");

    // The complete bundle renders.
    const before = await handleRequest(mockRequest(`/ticket/${group.slug}`));
    expect(before.status).toBe(200);

    // Deactivating one member makes the all-or-nothing bundle incomplete, so the
    // saved/direct URL must 404 rather than sell the active subset — matching how
    // /listings and the group QR already hide it.
    await deactivateTestListing(second.id);
    const after = await handleRequest(mockRequest(`/ticket/${group.slug}`));
    expect(after.status).toBe(404);
  });

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
    const group = await createTestGroup({ name: "ParentG", slug: "parent-g" });
    const parent = await member(group, "Parent Member");
    const child = await createTestListing({ name: "Child Of Parent" });
    await setChildIds(parent.id, [child.id]);
    // A VISIBLE package renders the member's child selector, so a parent
    // member is fine…
    await expectPackageAccepted(group);
    // …but hiding the package would collapse members to the package name, so a
    // child selector would leak them — the hide save is rejected.
    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields(group.name, group.slug),
      hide_package_listings: "1",
      is_package: "1",
    });
    await expectFlashRedirect(
      `/admin/groups/${group.id}/edit`,
      expect.stringContaining("Packages cannot contain"),
      false,
    )(response);
    expect((await groupsTable.findById(group.id))!.hide_package_listings).toBe(
      false,
    );
  });

  test("edit POST rejects is_package on a group whose member is another listing's child", async () => {
    const group = await createTestGroup({ name: "ChildG", slug: "child-g" });
    const childMember = await member(group, "Child Member");
    const parent = await createTestListing({ name: "Outside Gate" });
    await setChildIds(parent.id, [childMember.id]);
    // A package member is only ever sold as part of its bundle, so a listing
    // folded under another parent can't be packaged — visible or not.
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

  test("the listings API lets a parent join a visible package but not a hidden one", async () => {
    const parent = await createTestListing({ name: "Parent List" });
    const child = await createTestListing({ name: "Child List" });
    await setChildIds(parent.id, [child.id]);

    // A visible package renders the member's child selector, so the parent
    // joins with its gate intact.
    const visible = await createTestGroup({
      isPackage: true,
      name: "ParentApiPkg",
      slug: "parent-api-pkg",
    });
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { group_ids: [visible.id] },
        method: "PUT",
      }),
      200,
    );
    expect(await getChildIds(parent.id)).toEqual([child.id]);

    // A hidden package collapses members to the package name, so a member's
    // child selector would leak them — the join is rejected.
    const hidden = await createTestGroup({
      isPackage: true,
      name: "HiddenApiPkg",
      slug: "hidden-api-pkg",
    });
    await groupsTable.update(hidden.id, { hidePackageListings: true });
    await assertJson(
      apiRequest(`/api/admin/listings/${parent.id}`, {
        body: { group_ids: [hidden.id] },
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

  test("the listings API accepts new child edges into a visible package but not a hidden one", async () => {
    const child = await createTestListing({ name: "Edge Child" });

    const visible = await createTestGroup({
      isPackage: true,
      name: "ChildEdgePkg",
      slug: "child-edge-pkg",
    });
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

    const hidden = await createTestGroup({
      isPackage: true,
      name: "HiddenEdgePkg",
      slug: "hidden-edge-pkg",
    });
    await groupsTable.update(hidden.id, { hidePackageListings: true });
    await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          child_listing_ids: [child.id],
          group_ids: [hidden.id],
          max_attendees: 10,
          name: "New Parent In Hidden Package",
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

  test("the children sub-form lets a visible package's member gain children, but not a hidden one's", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "ChildFormPkg",
      slug: "child-form-pkg",
    });
    const memberListing = await member(group, "Pkg Member");
    const child = await createTestListing({ name: "Would-be Child" });

    // Visible package: the member's child gate saves and the package page can
    // render its selector.
    const { response: accepted } = await adminFormPost(
      `/admin/listing/${memberListing.id}/children`,
      { child_listing_ids: String(child.id) },
    );
    expect(accepted.status).toBe(302);
    expect(await getChildIds(memberListing.id)).toEqual([child.id]);
    await setChildIds(memberListing.id, []);

    // Hidden package: the same edge would leak the collapsed member.
    await groupsTable.update(group.id, { hidePackageListings: true });
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

  test("add-listings rejects a pay-what-you-want listing", async () => {
    // The one remaining type restriction: a package needs an operator-set
    // price per member, so buyer-priced listings can't join.
    const group = await createTestGroup({
      isPackage: true,
      name: "PkgAdd",
      slug: "pkg-add",
    });
    const donate = await createTestListing({
      canPayMore: true,
      name: "Donate Add",
    });

    await expectAddListingRejected(group, donate.id);
  });

  test("add-listings accepts a customisable-days listing into a package group", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "PkgFlex",
      slug: "pkg-flex",
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
    expect(response.status).toBe(302);
    const prices = await getGroupPackagePrices(group.id);
    expect(prices.map((r) => r.listing_id)).toContain(flexible.id);
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

  /** A hidden package with one member listing, returning the member. */
  const hiddenPackageMember = async (name: string) => {
    const group = await createTestGroup({ isPackage: true, name });
    await groupsTable.update(group.id, { hidePackageListings: true });
    return member(group, `${name} member`);
  };

  test("a hidden package member's admin detail suppresses share/QR affordances", async () => {
    const listing = await hiddenPackageMember("HideShare");
    const body = await (await adminGet(`/admin/listing/${listing.id}`)).text();
    expect(body).not.toContain(`/admin/listing/${listing.id}/qr`);
    expect(body).not.toContain(`/ticket/${listing.slug}`);
    expect(body).toContain("buyers book it only through the package");
    expect(body).not.toContain(`embed-script-${listing.id}`);
    expect(body).not.toContain(`embed-iframe-${listing.id}`);
  });

  test("a hidden package member's admin QR generator route 404s", async () => {
    const listing = await hiddenPackageMember("HideQr");
    const res = await adminGet(`/admin/listing/${listing.id}/qr`);
    res.body?.cancel();
    expect(res.status).toBe(404);
    const json = await adminGet(`/admin/listing/${listing.id}/qr.json`);
    json.body?.cancel();
    expect(json.status).toBe(404);
  });

  test("a package's admin share links are gated on bookability", async () => {
    const group = await createTestGroup({ isPackage: true, name: "ShareGate" });
    const only = await member(group, "Only Member");

    // Bookable bundle: the admin detail offers the public link.
    const before = await (await adminGet(`/admin/groups/${group.id}`)).text();
    expect(before).toContain(`/ticket/${group.slug}`);

    // Deactivating the sole member makes the bundle unbookable, so /ticket/<group>
    // now 404s and the admin share/QR/embed links are suppressed.
    await deactivateTestListing(only.id);
    const after = await (await adminGet(`/admin/groups/${group.id}`)).text();
    expect(after).not.toContain(`/ticket/${group.slug}`);
    expect(after).toContain("isn't currently bookable");
  });

  test("a regular group whose only members are hidden-package members offers no share links", async () => {
    // The member belongs to a hidden package AND a regular group. The public
    // /ticket/<regular> drops the hidden member, leaving an empty visible set, so
    // it 404s — the admin detail must not advertise that dead link.
    const pkg = await createTestGroup({ isPackage: true, name: "HideOnly" });
    await groupsTable.update(pkg.id, { hidePackageListings: true });
    const shared = await member(pkg, "Hidden Shared Member");
    const regular = await createTestGroup({
      name: "RegularEmpty",
      slug: "regular-empty",
    });
    await assignListingsToGroup([shared.id], regular.id);

    const html = await (await adminGet(`/admin/groups/${regular.id}`)).text();
    expect(html).not.toContain(`/ticket/${regular.slug}`);
    expect(html).toContain("isn't currently bookable");
  });

  test("deleting a sold hidden package un-groups its items", async () => {
    // Deleting a package with sold tickets is allowed: the group and its
    // membership rows go, but the member listings and their bookings survive.
    // Existing tickets stop resolving the package id and fall back to
    // per-member cards (the operator deliberately dissolved the package).
    const { group, memberListing, token } = await hiddenPackageWithBooking(
      "Sold Kit",
      "sold-kit",
    );
    const { response } = await adminFormPost(
      `/admin/groups/${group.id}/delete`,
      { confirm_identifier: "Sold Kit" },
    );
    expect(response.status).toBe(302);
    expect(await groupsTable.findById(group.id)).toBeNull();

    // The member listing survives, un-grouped.
    const { getListing } = await import("#shared/db/listings.ts");
    expect(await getListing(memberListing.id)).not.toBeNull();

    // The sold ticket still renders — as the member's own card now that the
    // package no longer resolves.
    const { handleRequest } = await import("#routes");
    const { mockRequest } = await import("#test-utils/mocks.ts");
    const body = await (await handleRequest(mockRequest(`/t/${token}`))).text();
    expect(body).toContain("Sold Kit Member");
  });

  test("un-packaging a hidden package with sold tickets is allowed", async () => {
    // Clearing is_package un-groups the sold bundle the same way deleting does;
    // existing tickets fall back to per-member cards.
    const { group } = await hiddenPackageWithBooking("Lock Kit", "lock-kit");
    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Lock Kit", "lock-kit"),
    });
    expect(response.status).toBe(302);
    expect((await groupsTable.findById(group.id))!.is_package).toBe(false);
  });

  test("allows deleting a hidden package with no sold tickets", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Empty Kit",
      slug: "empty-kit",
    });
    await groupsTable.update(group.id, { hidePackageListings: true });
    await member(group, "Empty Member");
    const { response } = await adminFormPost(
      `/admin/groups/${group.id}/delete`,
      { confirm_identifier: "Empty Kit" },
    );
    expect(response.status).toBe(302);
    expect(await groupsTable.findById(group.id)).toBeNull();
  });

  test("allows un-packaging a NON-hidden package even with sold tickets", async () => {
    // A visible package never concealed its members, so un-packaging it can't
    // reveal anything — the guard only fires for hidden packages.
    const group = await createTestGroup({
      isPackage: true,
      name: "Open Kit",
      slug: "open-kit",
    });
    const only = await member(group, "Open Member");
    await sellPackageTicket(only.id, group.id);
    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      ...editFields("Open Kit", "open-kit"),
    });
    expect(response.status).toBe(302);
    expect((await groupsTable.findById(group.id))!.is_package).toBe(false);
  });

  test("the groups API deletes a sold hidden package by un-grouping it", async () => {
    const { group, memberListing } = await hiddenPackageWithBooking(
      "Api Kit",
      "api-kit",
    );
    await assertJson(
      apiRequest(`/api/admin/groups/${group.id}`, {
        body: { confirm_identifier: "Api Kit" },
        method: "DELETE",
      }),
      200,
      (body) => {
        expect(body.status).toBe("ok");
      },
    );
    expect(await groupsTable.findById(group.id)).toBeNull();
    const { getListing } = await import("#shared/db/listings.ts");
    expect(await getListing(memberListing.id)).not.toBeNull();
  });
});
