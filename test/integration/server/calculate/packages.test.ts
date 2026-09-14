/** Package and group quotes on the `/calculate` running total: what a
 * package costs (member overrides, per-package quantities, capacity clamps),
 * and what a hidden package's fragment is allowed to name. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import { formatCurrency } from "#shared/currency.ts";
import { postRunningTotal, quoteTicketHtml } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** Quote a package by its package count and return the summary HTML. */
const quotePackage = (
  group: { id: number; slug: string },
  count: string,
): Promise<string> =>
  quoteTicketHtml(group.slug, { [`package_quantity_${group.id}`]: count });

describeWithEnv("server (/calculate package quotes)", { db: true }, () => {
  test("a hidden package's quote fragment names the package, never a member", async () => {
    await setupStripe();
    const group = await createTestGroup({
      hidden: false,
      isPackage: true,
      name: "Mystery Box",
      slug: "mystery-box",
    });
    const { groups } = await import("#db/groups.ts");
    await groups.table.update(group.id, { hidePackageListings: true });
    const member = await createTestListing({
      groupId: group.id,
      name: "Secret Contents",
      unitPrice: 1200,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: null },
    ]);

    const response = await postRunningTotal(group.slug, group.slug, {
      [`package_quantity_${group.id}`]: "1",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Mystery Box");
    expect(html).toContain(formatCurrency(1200));
    expect(html).not.toContain("Secret Contents");
  });

  test("quotes a package member at its override price, not its base price", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      name: "Day Pass",
      slug: "day-pass",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxQuantity: 5,
      name: "Pass Member",
      unitPrice: 5000,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 1500 },
    ]);

    // A package is booked by package count, not per-member quantities.
    const html = await quotePackage(group, "1");
    // The package override (1500) prices the line — not the 5000 base.
    expect(html).toContain(formatCurrency(1500));
    expect(html).not.toContain(formatCurrency(5000));
  });

  test("quotes an explicit-free package member at zero, not its base price", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      name: "Free Pass",
      slug: "free-pass",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxQuantity: 5,
      name: "Free Member",
      unitPrice: 5000,
    });
    // An explicit free override (0), distinct from "no override" which would
    // charge the 5000 base.
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 0 },
    ]);

    const html = await quotePackage(group, "1");
    expect(html).toContain(formatCurrency(0));
    expect(html).not.toContain(formatCurrency(5000));
  });

  test("an absent or invalid package quantity quotes nothing", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      name: "Zero Pkg",
      slug: "zero-pkg",
    });
    const member = await createTestListing({
      groupId: group.id,
      name: "Z",
      unitPrice: 5000,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 1000 },
    ]);

    // "abc" → 0 packages → empty order.
    const response = await postRunningTotal(group.slug, group.slug, {
      [`package_quantity_${group.id}`]: "abc",
    });
    expect(await response.text()).toContain("select at least one");
  });

  test("multiplies a package member's line by its quantity and the package count", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      name: "Bundle",
      slug: "bundle-qty",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxQuantity: 50,
      name: "Bundled",
      unitPrice: 5000,
    });
    // 3 of this listing per package, overridden to 1000 each.
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 1000, quantity: 3 },
    ]);

    // 2 packages → 6 units × 1000 = 6000.
    const html = await quotePackage(group, "2");
    expect(html).toContain(formatCurrency(6000));
  });

  test("clamps the package count to the tightest member's capacity", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      name: "Capped",
      slug: "capped-pkg",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maxQuantity: 2,
      name: "Limited",
      unitPrice: 4000,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 1000 },
    ]);

    // The member caps the package at 2 (max_quantity); a crafted count of 5
    // clamps to 2 → 2 × 1000 = 2000, never 5 × 1000.
    const html = await quotePackage(group, "5");
    expect(html).toContain(formatCurrency(2000));
    expect(html).not.toContain(formatCurrency(5000));
  });

  test("caps the package count by the group's shared pool across members", async () => {
    await setupStripe();
    const group = await createTestGroup({
      isPackage: true,
      maxAttendees: 2,
      name: "Shared Pool",
      slug: "shared-pool",
    });
    const a = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maxQuantity: 10,
      name: "Pool A",
      unitPrice: 0,
    });
    const b = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      maxQuantity: 10,
      name: "Pool B",
      unitPrice: 0,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: a.id, price: 1000 },
      { listingId: b.id, price: 1000 },
    ]);

    // The group holds 2; one package consumes 1 A + 1 B = 2 spots, so only one
    // package fits. Posting 2 clamps to 1 → 1×1000 + 1×1000 = 2000, not 4000.
    const html = await quotePackage(group, "2");
    expect(html).toContain(formatCurrency(2000));
    expect(html).not.toContain(formatCurrency(4000));
  });

  test("prices a group booking posted to the group slug", async () => {
    await setupStripe();
    const group = await createTestGroup({ name: "Festival", slug: "festival" });
    const listing = await createTestListing({
      groupId: group.id,
      hidden: true,
      maxQuantity: 5,
      name: "Day Pass",
      unitPrice: 2000,
    });

    const response = await postRunningTotal("festival", "festival", {
      [`quantity_${listing.id}`]: "1",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await response.text();
    expect(html).toContain("Day Pass");
    expect(html).toContain(formatCurrency(2000));
  });
});
