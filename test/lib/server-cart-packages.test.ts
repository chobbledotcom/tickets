import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectPackageBookingAccepted,
  mockRequest,
  submitPackageBooking,
} from "#test-utils";

/**
 * Multi-slug cart bookings (`/ticket/<slug>+<slug>`) where slugs name PACKAGE
 * groups alongside listings — the pages the order gallery's cart redirects to.
 * The overlap rule under test: a visitor may book any combination of packages
 * and listings the stock covers, including the SAME listing through a package
 * and its own standalone row at once (one booking row per path).
 */

/** A free one-member package (member price 0 inside the bundle). */
const freePackage = async (name: string, slug: string, memberName: string) => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: memberName,
    unitPrice: 0,
  });
  await setGroupPackageMembers(group.id, [{ listingId: member.id, price: 0 }]);
  return { group, member };
};

/** The booking rows for a listing, oldest first. */
const bookingRows = (
  listingId: number,
): Promise<{ quantity: number; package_group_id: number }[]> =>
  queryAll(
    `SELECT quantity, package_group_id FROM listing_attendees
      WHERE listing_id = ? ORDER BY id ASC`,
    [listingId],
  );

const pageHtml = async (slugs: string): Promise<string> =>
  (await handleRequest(mockRequest(`/ticket/${slugs}`))).text();

describeWithEnv(
  "cart bookings (/ticket/<package>+<listing>)",
  { db: true },
  () => {
    test("renders a package section beside a standalone listing row", async () => {
      const { group } = await freePackage("Camp Kit", "camp-kit", "Kit Tent");
      const solo = await createTestListing({
        maxQuantity: 5,
        name: "Lantern",
        unitPrice: 0,
      });

      const html = await pageHtml(`${group.slug}+${solo.slug}`);
      // The bundle keeps its own count selector; the listing keeps its row.
      expect(html).toContain(`name="package_quantity_${group.id}"`);
      expect(html).toContain(`name="quantity_${solo.id}"`);
      expect(html).toContain("Camp Kit");
      expect(html).toContain("Kit Tent");
      expect(html).toContain("Lantern");
    });

    test("a member added by its own slug sells through both paths at once", async () => {
      const { group, member } = await freePackage(
        "Camp Kit",
        "camp-kit",
        "Kit Tent",
      );

      const html = await pageHtml(`${group.slug}+${member.slug}`);
      // One package section (read-only member row) AND one standalone quantity
      // row for the same listing — the two bookable paths.
      expect(html).toContain(`name="package_quantity_${group.id}"`);
      expect(html).toContain(`name="quantity_${member.id}"`);
    });

    test("books one row per path when a package and its member's own row are both taken", async () => {
      const { group, member } = await freePackage(
        "Camp Kit",
        "camp-kit",
        "Kit Tent",
      );

      const submit = await submitPackageBooking(
        `${group.slug}+${member.slug}`,
        {
          email: "both@test.com",
          name: "Both Paths",
          [`package_quantity_${group.id}`]: "1",
          [`quantity_${member.id}`]: "2",
        },
      );
      await expectPackageBookingAccepted(submit);

      // Two rows for the one listing: the package path (stamped with the group)
      // and the standalone path (unstamped) — never a merged 3-unit row.
      const rows = await bookingRows(member.id);
      expect(rows).toHaveLength(2);
      const byGroup = new Map(
        rows.map((row) => [Number(row.package_group_id), row.quantity]),
      );
      expect(byGroup.get(group.id)).toBe(1);
      expect(byGroup.get(0)).toBe(2);
    });

    test("books two packages beside a plain listing in one order", async () => {
      const camp = await freePackage("Camp Kit", "camp-kit", "Kit Tent");
      const beach = await freePackage("Beach Kit", "beach-kit", "Kit Towel");
      const solo = await createTestListing({
        maxQuantity: 5,
        name: "Lantern",
        unitPrice: 0,
      });

      const slugs = `${camp.group.slug}+${beach.group.slug}+${solo.slug}`;
      const html = await pageHtml(slugs);
      expect(html).toContain(`name="package_quantity_${camp.group.id}"`);
      expect(html).toContain(`name="package_quantity_${beach.group.id}"`);

      const submit = await submitPackageBooking(slugs, {
        email: "trio@test.com",
        name: "Trio Buyer",
        [`package_quantity_${camp.group.id}`]: "1",
        [`package_quantity_${beach.group.id}`]: "2",
        [`quantity_${solo.id}`]: "1",
      });
      await expectPackageBookingAccepted(submit);

      expect(await bookingRows(camp.member.id)).toEqual([
        { package_group_id: camp.group.id, quantity: 1 },
      ]);
      expect(await bookingRows(beach.member.id)).toEqual([
        { package_group_id: beach.group.id, quantity: 2 },
      ]);
      expect(await bookingRows(solo.id)).toEqual([
        { package_group_id: 0, quantity: 1 },
      ]);
    });

    test("a hidden package's member never sells standalone, whatever the URL claims", async () => {
      const { group, member } = await freePackage(
        "Mystery Box",
        "mystery-box",
        "Secret Widget",
      );
      const { groupsTable } = await import("#shared/db/groups.ts");
      await groupsTable.update(group.id, { hidePackageListings: true });
      const solo = await createTestListing({ name: "Lantern", unitPrice: 0 });

      const html = await pageHtml(`${group.slug}+${member.slug}+${solo.slug}`);
      // The bundle sells by name only: no standalone row, no member name.
      expect(html).toContain("Mystery Box");
      expect(html).toContain(`name="package_quantity_${group.id}"`);
      expect(html).not.toContain("Secret Widget");
      expect(html).not.toContain(`name="quantity_${member.id}"`);
    });

    test("drops a non-package group's slug like any unknown slug", async () => {
      const { group } = await freePackage("Camp Kit", "camp-kit", "Kit Tent");
      const regular = await createTestGroup({
        name: "Plain Crowd",
        slug: "plain-crowd",
      });
      await createTestListing({ groupId: regular.id, name: "Crowd Item" });

      const html = await pageHtml(`${regular.slug}+${group.slug}`);
      // The package still sells; the regular group's slug names no cart item.
      expect(html).toContain(`name="package_quantity_${group.id}"`);
      expect(html).not.toContain("Crowd Item");
    });

    test("drops an incomplete package (a member deactivated) from the cart", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Broken Kit",
        slug: "broken-kit",
      });
      const kept = await createTestListing({
        groupId: group.id,
        name: "Kept Part",
        unitPrice: 0,
      });
      const dropped = await createTestListing({
        groupId: group.id,
        name: "Gone Part",
        unitPrice: 0,
      });
      await setGroupPackageMembers(group.id, [
        { listingId: kept.id, price: 0 },
        { listingId: dropped.id, price: 0 },
      ]);
      const { deactivateTestListing } = await import("#test-utils");
      await deactivateTestListing(dropped.id);
      const whole = await freePackage("Camp Kit", "camp-kit", "Kit Tent");

      // The incomplete bundle must never sell partially: its slug drops while
      // the intact package books on.
      const html = await pageHtml(`${group.slug}+${whole.group.slug}`);
      expect(html).not.toContain(`name="package_quantity_${group.id}"`);
      expect(html).not.toContain("Kept Part");
      expect(html).toContain(`name="package_quantity_${whole.group.id}"`);
    });

    test("404s a cart whose every listing is another listing's child", async () => {
      // The package's lone member is itself a required child, so the child drop
      // empties the cart — nothing is sellable at top level.
      const { group, member } = await freePackage(
        "Addon Kit",
        "addon-kit",
        "Addon Widget",
      );
      const parent = await createTestListing({ name: "Big Parent" });
      const { setChildIds } = await import("#shared/db/listing-parents.ts");
      await setChildIds(parent.id, [member.id]);

      const response = await handleRequest(
        mockRequest(`/ticket/${group.slug}+zzzzz`),
      );
      await response.body?.cancel();
      expect(response.status).toBe(404);
    });

    test("a cart with no package at all falls through to the plain multi-listing page", async () => {
      const a = await createTestListing({ name: "Alpha" });
      const b = await createTestListing({ name: "Bravo" });
      const html = await pageHtml(`${a.slug}+${b.slug}`);
      expect(html).toContain(`name="quantity_${a.id}"`);
      expect(html).toContain(`name="quantity_${b.id}"`);
      expect(html).not.toContain("package_quantity_");
    });
  },
);
