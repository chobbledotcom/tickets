import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  getGroupPackagePrices,
  groupsTable,
  packageChildrenDeterministic,
  packageMemberEdgesOk,
  setGroupPackageMembers,
} from "#shared/db/groups.ts";
import { getChildIds, setChildIds } from "#shared/db/listing-parents.ts";
import type { ListingInput } from "#shared/db/listings.ts";
import { validateListingInput } from "#shared/listings-actions.ts";
import { isPackageableListing, type Listing } from "#shared/types.ts";
import { packageQuantityCap } from "#templates/public/reservations.tsx";
import type { TicketListing } from "#templates/public.tsx";
import {
  adminFormPost,
  bookingPageHtml,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  duplicateTestListing,
  expectFlashRedirect,
  postCalculate,
  postChildren,
  setupStripe,
  testListingInput,
} from "#test-utils";

// ---------------------------------------------------------------------------
// Pure predicate: isPackageableListing
// ---------------------------------------------------------------------------

describe("isPackageableListing", () => {
  const make = (over: Partial<Listing>): Listing =>
    ({
      can_pay_more: false,
      customisable_days: false,
      listing_type: "standard",
      ...over,
    }) as Listing;

  test("a plain standard fixed-price listing is packageable", () => {
    expect(isPackageableListing(make({}))).toBe(true);
  });

  test("a daily listing is not packageable", () => {
    expect(isPackageableListing(make({ listing_type: "daily" }))).toBe(false);
  });

  test("a customisable-days listing is not packageable", () => {
    expect(isPackageableListing(make({ customisable_days: true }))).toBe(false);
  });

  test("a pay-what-you-want listing is not packageable", () => {
    expect(isPackageableListing(make({ can_pay_more: true }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: packageQuantityCap with auto-included children
// ---------------------------------------------------------------------------

describe("packageQuantityCap (auto-included children)", () => {
  /** A minimal TicketListing — the cap only reads `listing.id` + maxPurchasable. */
  const leaf = (id: number, maxPurchasable: number): TicketListing =>
    ({ listing: { id }, maxPurchasable }) as unknown as TicketListing;

  test("ignores children when none are auto-included", () => {
    // Member ×1, own cap 4 → 4 packages; no group caps.
    const cap = packageQuantityCap(
      [leaf(1, 4)],
      new Map([[1, 1]]),
      new Map(),
      new Map(),
    );
    expect(cap).toBe(4);
  });

  test("bounds the package by the auto-included child's own capacity", () => {
    // Member id 1 own cap 10 (×1/package), child id 2 own cap 2 (×1/package).
    // Without the child the cap would be 10; the child clamps it to 2.
    const cap = packageQuantityCap(
      [leaf(1, 10)],
      new Map([[1, 1]]),
      new Map(),
      new Map(),
      new Map([[1, [leaf(2, 2)]]]),
    );
    expect(cap).toBe(2);
  });

  test("the child consumes the member's per-package quantity", () => {
    // Member ×2/package, own cap 100; child rides at ×2/package, own cap 5 →
    // floor(5 / 2) = 2 packages.
    const cap = packageQuantityCap(
      [leaf(1, 100)],
      new Map([[1, 2]]),
      new Map(),
      new Map(),
      new Map([[1, [leaf(2, 5)]]]),
    );
    expect(cap).toBe(2);
  });

  test("counts the child's demand against a capped group it belongs to", () => {
    // Member id 1 in no capped group; child id 2 in capped group 7 with 2 left.
    // One package needs 1 of the child, so the group bounds it at floor(2/1)=2.
    const cap = packageQuantityCap(
      [leaf(1, 100)],
      new Map([[1, 1]]),
      new Map([[7, 2]]),
      new Map([[2, [7]]]),
      new Map([[1, [leaf(2, 100)]]]),
    );
    expect(cap).toBe(2);
  });

  test("sums member and child demand in a group they share", () => {
    // Member 1 and child 2 both in capped group 7 (3 left). One package consumes
    // 1 of each = 2 spots → floor(3/2) = 1 package.
    const cap = packageQuantityCap(
      [leaf(1, 100)],
      new Map([[1, 1]]),
      new Map([[7, 3]]),
      new Map([
        [1, [7]],
        [2, [7]],
      ]),
      new Map([[1, [leaf(2, 100)]]]),
    );
    expect(cap).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DB-backed predicates + admin validation + booking
// ---------------------------------------------------------------------------

/** A standalone packageable (standard, fixed-price) listing. */
const standardListing = (name: string, over: Record<string, unknown> = {}) =>
  createTestListing({ maxQuantity: 50, name, unitPrice: 1000, ...over });

describeWithEnv("server (package auto-include)", { db: true }, () => {
  // -- packageChildrenDeterministic -----------------------------------------

  test("packageChildrenDeterministic: no children is deterministic", async () => {
    expect(await packageChildrenDeterministic([])).toBe(true);
  });

  test("packageChildrenDeterministic: a sole packageable child is deterministic", async () => {
    const child = await standardListing("SoleChild");
    expect(await packageChildrenDeterministic([child.id])).toBe(true);
  });

  test("packageChildrenDeterministic: more than one child is non-deterministic", async () => {
    const a = await standardListing("ChildA");
    const b = await standardListing("ChildB");
    expect(await packageChildrenDeterministic([a.id, b.id])).toBe(false);
  });

  test("packageChildrenDeterministic: a non-packageable child is non-deterministic", async () => {
    const child = await standardListing("PayMoreChild", {
      canPayMore: true,
      maxPrice: 5000,
    });
    expect(await packageChildrenDeterministic([child.id])).toBe(false);
  });

  test("packageChildrenDeterministic: a missing child is non-deterministic", async () => {
    expect(await packageChildrenDeterministic([999999])).toBe(false);
  });

  // -- packageMemberEdgesOk -------------------------------------------------

  test("packageMemberEdgesOk: a plain listing with no edges is ok", async () => {
    const listing = await standardListing("Plain");
    expect(await packageMemberEdgesOk(listing.id)).toBe(true);
  });

  test("packageMemberEdgesOk: a parent with a sole packageable child is ok", async () => {
    const parent = await standardListing("Parent");
    const child = await standardListing("Child");
    await setChildIds(parent.id, [child.id]);
    expect(await packageMemberEdgesOk(parent.id)).toBe(true);
  });

  test("packageMemberEdgesOk: a listing that is itself a child is rejected", async () => {
    const parent = await standardListing("ParentX");
    const member = await standardListing("WouldBeMember");
    await setChildIds(parent.id, [member.id]);
    expect(await packageMemberEdgesOk(member.id)).toBe(false);
  });

  test("packageMemberEdgesOk: a parent with two children is rejected", async () => {
    const parent = await standardListing("Parent2");
    const a = await standardListing("C1");
    const b = await standardListing("C2");
    await setChildIds(parent.id, [a.id, b.id]);
    expect(await packageMemberEdgesOk(parent.id)).toBe(false);
  });

  // -- group membership validation ------------------------------------------

  /** Add `listingId` to package `group` via the admin form; assert accepted
   * (a priced member row now exists). */
  const expectAddAccepted = async (
    group: { id: number },
    listingId: number,
  ): Promise<void> => {
    const { response } = await adminFormPost(
      `/admin/groups/${group.id}/add-listings`,
      { listing_ids: String(listingId) },
    );
    expect(response.status).toBe(302);
    const ids = (await getGroupPackagePrices(group.id)).map(
      (r) => r.listing_id,
    );
    expect(ids).toContain(listingId);
  };

  /** Add `listingId` to package `group`; assert the package invariant rejected
   * it, leaving no member rows. */
  const expectAddRejected = async (
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

  test("a parent whose sole child is packageable is accepted as a member", async () => {
    const group = await createTestGroup({ isPackage: true, name: "P1" });
    const parent = await standardListing("MemberParent");
    const child = await standardListing("AutoChild");
    await setChildIds(parent.id, [child.id]);
    await expectAddAccepted(group, parent.id);
  });

  test("a parent with two children is rejected as a member", async () => {
    const group = await createTestGroup({ isPackage: true, name: "P2" });
    const parent = await standardListing("TwoChildParent");
    const a = await standardListing("Two1");
    const b = await standardListing("Two2");
    await setChildIds(parent.id, [a.id, b.id]);
    await expectAddRejected(group, parent.id);
  });

  test("a parent whose sole child is non-packageable is rejected", async () => {
    const group = await createTestGroup({ isPackage: true, name: "P3" });
    const parent = await standardListing("PayMoreChildParent");
    const child = await standardListing("PayMoreKid", {
      canPayMore: true,
      maxPrice: 5000,
    });
    await setChildIds(parent.id, [child.id]);
    await expectAddRejected(group, parent.id);
  });

  test("a listing that is itself a child is rejected as a member", async () => {
    const group = await createTestGroup({ isPackage: true, name: "P4" });
    const parent = await standardListing("OuterParent");
    const wouldBeMember = await standardListing("ChildMember");
    await setChildIds(parent.id, [wouldBeMember.id]);
    await expectAddRejected(group, wouldBeMember.id);
  });

  // -- child-edge save validation (postChildren) ----------------------------

  test("a package member may gain a single packageable child", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Edge1" });
    const parent = await standardListing("EdgeParent", { groupId: group.id });
    const child = await standardListing("EdgeChild");
    const response = await postChildren(parent.id, [child.id]);
    expect(response.status).toBe(302);
    expect(await getChildIds(parent.id)).toEqual([child.id]);
  });

  test("a package member may not gain a second child", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Edge2" });
    const parent = await standardListing("EdgeParent2", { groupId: group.id });
    const a = await standardListing("EdgeC1");
    const b = await standardListing("EdgeC2");
    const response = await postChildren(parent.id, [a.id, b.id]);
    await expectFlashRedirect(
      `/admin/listing/${parent.id}/edit`,
      expect.stringContaining("Packages cannot contain"),
      false,
    )(response);
    expect(await getChildIds(parent.id)).toEqual([]);
  });

  test("a package member may not be chosen as another listing's child", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Edge3" });
    const packageMember = await standardListing("EdgeMember", {
      groupId: group.id,
    });
    const outer = await standardListing("EdgeOuter");
    const response = await postChildren(outer.id, [packageMember.id]);
    await expectFlashRedirect(
      `/admin/listing/${outer.id}/edit`,
      expect.stringContaining("Packages cannot contain"),
      false,
    )(response);
    expect(await getChildIds(outer.id)).toEqual([]);
  });

  // -- listing-save: editing the child's type -------------------------------

  /** Build a full update input for `listing` with the given overrides applied. */
  const updateInput = (
    listing: Listing,
    over: Partial<ListingInput>,
  ): ListingInput =>
    ({
      ...testListingInput({ name: listing.name, unitPrice: 1000 }),
      slug: listing.slug,
      slugIndex: "idx",
      ...over,
    }) as ListingInput;

  test("turning a package member's child pay-what-you-want is blocked", async () => {
    const group = await createTestGroup({ isPackage: true, name: "CT1" });
    const parent = await standardListing("CTParent", { groupId: group.id });
    const child = await standardListing("CTChild");
    await setChildIds(parent.id, [child.id]);

    const error = await validateListingInput(
      updateInput(child, { canPayMore: true, maxPrice: 5000 }),
      child.id,
    );
    expect(error).toEqual(expect.stringContaining("Packages cannot contain"));
  });

  test("keeping a package member's child packageable is allowed", async () => {
    const group = await createTestGroup({ isPackage: true, name: "CT2" });
    const parent = await standardListing("CTParent2", { groupId: group.id });
    const child = await standardListing("CTChild2");
    await setChildIds(parent.id, [child.id]);

    expect(
      await validateListingInput(updateInput(child, {}), child.id),
    ).toBeNull();
  });

  test("a non-packageable change is fine when the parent is not a package member", async () => {
    const parent = await standardListing("PlainParent");
    const child = await standardListing("PlainChild");
    await setChildIds(parent.id, [child.id]);

    expect(
      await validateListingInput(
        updateInput(child, { canPayMore: true, maxPrice: 5000 }),
        child.id,
      ),
    ).toBeNull();
  });

  test("a non-packageable change is fine for a listing with no parent", async () => {
    const orphan = await standardListing("Orphan");
    expect(
      await validateListingInput(
        updateInput(orphan, { canPayMore: true, maxPrice: 5000 }),
        orphan.id,
      ),
    ).toBeNull();
  });

  // -- fold + pricing -------------------------------------------------------

  /** A package whose sole member-parent auto-includes one packageable child. */
  const autoIncludePackage = async (opts: {
    slug: string;
    parentBase?: number;
    parentOverride?: number;
    childBase?: number;
    parentQty?: number;
    parentMaxQuantity?: number;
    parentMaxAttendees?: number;
    childMaxQuantity?: number;
    childMaxAttendees?: number;
    childGroupId?: number;
    hide?: boolean;
  }) => {
    const group = await createTestGroup({
      isPackage: true,
      name: opts.slug,
      slug: opts.slug,
    });
    if (opts.hide) {
      await groupsTable.update(group.id, { hidePackageListings: true });
    }
    const parent = await createTestListing({
      groupId: group.id,
      maxAttendees: opts.parentMaxAttendees ?? 100,
      maxQuantity: opts.parentMaxQuantity ?? 50,
      name: `${opts.slug}-Parent`,
      unitPrice: opts.parentBase ?? 5000,
    });
    const child = await createTestListing({
      ...(opts.childGroupId ? { groupId: opts.childGroupId } : {}),
      maxAttendees: opts.childMaxAttendees ?? 100,
      maxQuantity: opts.childMaxQuantity ?? 50,
      name: `${opts.slug}-Child`,
      unitPrice: opts.childBase ?? 800,
    });
    await setChildIds(parent.id, [child.id]);
    await setGroupPackageMembers(group.id, [
      {
        listingId: parent.id,
        price: opts.parentOverride ?? 2000,
        quantity: opts.parentQty ?? 1,
      },
    ]);
    return { child, group, parent };
  };

  test("a package bundle prices the parent override plus the child's base price", async () => {
    await setupStripe();
    const { group } = await autoIncludePackage({ slug: "ai-price" });

    const html = await postCalculate(group.slug, { package_quantity: "1" });
    // Parent override 2000 + auto-included child base 800 = 2800.
    expect(html).toContain(formatCurrency(2000));
    expect(html).toContain(formatCurrency(800));
    expect(html).toContain(formatCurrency(2800));
    // Never the parent's own base price (the override replaces it).
    expect(html).not.toContain(formatCurrency(5000));
  });

  test("the auto-included child scales with the package count", async () => {
    await setupStripe();
    const { group } = await autoIncludePackage({
      childBase: 500,
      parentOverride: 1000,
      slug: "ai-scale",
    });

    const html = await postCalculate(group.slug, { package_quantity: "3" });
    // 3 packages → parent 3×1000 = 3000, child 3×500 = 1500, total 4500.
    expect(html).toContain(formatCurrency(4500));
  });

  // -- capacity -------------------------------------------------------------

  test("the package count is bounded by the auto-included child's own capacity", async () => {
    await setupStripe();
    const { group } = await autoIncludePackage({
      childBase: 500,
      childMaxQuantity: 2,
      parentMaxQuantity: 10,
      parentOverride: 1000,
      slug: "ai-childcap",
    });

    // The child caps the bundle at 2; a crafted count of 5 clamps to 2 →
    // 2×1000 + 2×500 = 3000, never the 5-package 7500.
    const html = await postCalculate(group.slug, { package_quantity: "5" });
    expect(html).toContain(formatCurrency(3000));
    expect(html).not.toContain(formatCurrency(7500));
  });

  test("the package count is bounded by a capped group the child belongs to", async () => {
    await setupStripe();
    // A separate capped group (2 spots) that only the child belongs to.
    const childGroup = await createTestGroup({
      maxAttendees: 2,
      name: "ChildPool",
      slug: "child-pool",
    });
    const { group } = await autoIncludePackage({
      childBase: 500,
      childGroupId: childGroup.id,
      parentMaxQuantity: 10,
      parentOverride: 1000,
      slug: "ai-childpool",
    });

    // The child's own group holds 2; one package consumes one child spot, so the
    // bundle clamps to 2 → 3000, never 7500.
    const html = await postCalculate(group.slug, { package_quantity: "5" });
    expect(html).toContain(formatCurrency(3000));
    expect(html).not.toContain(formatCurrency(7500));
  });

  // -- render + privacy -----------------------------------------------------

  test("a visible package shows the auto-included child riding along", async () => {
    const { group } = await autoIncludePackage({ slug: "ai-show" });
    const html = await bookingPageHtml(group.slug);
    expect(html).toContain("Includes");
    expect(html).toContain("ai-show-Child");
  });

  test("a hidden package conceals the auto-included child everywhere", async () => {
    const { group } = await autoIncludePackage({ hide: true, slug: "ai-hide" });
    const html = await bookingPageHtml(group.slug);
    // The member-parent's name and its auto-included child are both concealed.
    expect(html).not.toContain("ai-hide-Child");
    expect(html).not.toContain("ai-hide-Parent");
  });

  // -- duplicate ------------------------------------------------------------

  test("duplicating a package member-parent carries its sole child edge", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Dup" });
    const parent = await standardListing("DupParent", { groupId: group.id });
    const child = await standardListing("DupChild");
    await setChildIds(parent.id, [child.id]);

    const copy = await duplicateTestListing(parent.id, { groupId: group.id });
    // The copy keeps the auto-include gate (it references the same child).
    expect(await getChildIds(copy.id)).toEqual([child.id]);
  });
});
