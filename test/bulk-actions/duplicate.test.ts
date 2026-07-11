import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import {
  getGroupIdsByListingId,
  getGroupPackagePrices,
  getListingsByGroupId,
  groups,
} from "#shared/db/groups.ts";
import {
  getAllListings,
  getListingWithCount,
  getStoredListingWithCount,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  getTestPackagePrices,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, getBulkActionForm } from "#test-utils/session.ts";

const getDuplicateForm = getBulkActionForm("duplicate");

/** POST a duplicate that must be rejected on name uniqueness: assert it
 * redirects back to the form and creates no new group. */
const expectDuplicateRejected = async (
  groupId: number,
  body: Record<string, string>,
): Promise<void> => {
  const before = (await groups.cache.getAll()).length;
  const { response } = await adminFormPost(
    `/admin/groups/${groupId}/bulk-actions/duplicate`,
    body,
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain(
    `/admin/groups/${groupId}/bulk-actions/duplicate`,
  );
  expect((await groups.cache.getAll()).length).toBe(before);
};

describeWithEnv("Admin bulk actions — duplicate", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions/duplicate", () => {
    test("renders the duplicate form with listing preview data", async () => {
      const group = await createTestGroup({ name: "Original" });
      await createTestListing({ groupId: group.id, name: "Spring Workshop" });

      const html = await getDuplicateForm(group.id);

      expect(html).toContain("Duplicate Group");
      expect(html).toContain("Spring Workshop");
      expect(html).toContain('id="duplicate-preview-listings"');
      // The default "new group name" suggestion is pre-filled.
      expect(html).toContain("Original (copy)");
    });

    test("shows an empty-state message when the group has no listings", async () => {
      const group = await createTestGroup({ name: "Empty" });

      const html = await getDuplicateForm(group.id);

      expect(html).toContain("This group has no listings");
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/duplicate", () => {
    test("creates a new group and clones every listing with replacements applied", async () => {
      const group = await createTestGroup({ name: "Source" });
      const sourceListing = await createTestListing({
        date: "2026-04-16T09:00",
        groupId: group.id,
        name: "Spring Workshop",
      });

      const groupCountBefore = (await groups.cache.getAll()).length;
      const listingCountBefore = (await getAllListings()).length;

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "2026-04-16",
          date_replace: "2026-04-23",
          name_find: "Spring",
          name_replace: "Autumn",
          new_name: "Duplicated Source",
        },
      );

      expect(response.status).toBe(302);

      const groupsAfter = await groups.cache.getAll();
      expect(groupsAfter.length).toBe(groupCountBefore + 1);
      const newGroup = groupsAfter.find((g) => g.name === "Duplicated Source");
      expect(newGroup).toBeDefined();
      expect(newGroup!.slug).not.toBe(group.slug);

      // The redirect points at the new group's detail page
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${newGroup!.id}`,
      );

      const listingsAfter = await getAllListings();
      expect(listingsAfter.length).toBe(listingCountBefore + 1);
      const newListings = await getListingsByGroupId(newGroup!.id);
      expect(newListings.length).toBe(1);
      const duplicate = newListings[0]!;
      expect(duplicate.id).not.toBe(sourceListing.id);
      expect(duplicate.name).toBe("Autumn Workshop");

      // The original date is shifted by 7 days; the time-of-day is preserved
      // (the exact hour in UTC depends on the configured timezone and DST).
      const originalMs = Date.parse(sourceListing.date);
      const newMs = Date.parse(duplicate.date);
      expect(Math.round((newMs - originalMs) / 86_400_000)).toBe(7);

      // Source listing should still exist and be unchanged.
      const original = await getListingWithCount(sourceListing.id);
      expect(original?.name).toBe("Spring Workshop");
      expect(original?.date).toBe(sourceListing.date);
      expect(await getGroupIdsByListingId(sourceListing.id)).toContain(
        group.id,
      );
    });

    test("syncs listing_prices for cloned listings", async () => {
      // Clones are inserted via insertStatement in a batch (bypassing the
      // listingsTable wrapper), so the duplicate flow must sync their price rows.
      const group = await createTestGroup({ name: "Priced Source" });
      await createTestListing({
        groupId: group.id,
        name: "Priced Item",
        unitPrice: 850,
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          name_find: "Priced",
          name_replace: "Cloned",
          new_name: "Priced Copy",
        },
      );
      expect(response.status).toBe(302);

      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Priced Copy",
      )!;
      const clone = (await getListingsByGroupId(newGroup.id))[0]!;
      const rows = await queryAll<{ price_type: string; unit_price: number }>(
        "SELECT price_type, unit_price FROM listing_prices WHERE listing_id = ?",
        [clone.id],
      );
      expect(rows).toEqual([{ price_type: "base", unit_price: 850 }]);
    });

    test("clones a use-defaults listing from its stored values, not inherited defaults", async () => {
      // A Hidden=Yes default is live while we duplicate the group.
      await settings.update.listingDefaults({ hidden: true });
      const group = await createTestGroup({ name: "Inherits" });
      await createTestListing({
        groupId: group.id,
        hidden: false,
        name: "Inheriting member",
        useDefaults: true,
      });

      await adminFormPost(`/admin/groups/${group.id}/bulk-actions/duplicate`, {
        name_find: "Inheriting",
        name_replace: "Cloned",
        new_name: "Inherits copy",
      });

      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Inherits copy",
      )!;
      const clone = (await getListingsByGroupId(newGroup.id))[0]!;
      // The clone's OWN stored hidden is the source's stored false, not the
      // Hidden=Yes default — so clearing the default later won't strand it.
      expect((await getStoredListingWithCount(clone.id))?.hidden).toBe(false);
    });

    test("copies dates verbatim when no date replacement is given", async () => {
      const group = await createTestGroup({ name: "Verbatim" });
      const sourceListing = await createTestListing({
        date: "2026-05-01T10:00",
        groupId: group.id,
        name: "Untouched",
      });

      // A name replacement is still required — names are unique, so a clone may
      // not keep the source's name — but an empty date replacement leaves the
      // date verbatim.
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          name_find: "Untouched",
          name_replace: "Renamed",
          new_name: "Verbatim Copy",
        },
      );

      expect(response.status).toBe(302);
      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Verbatim Copy",
      );
      expect(newGroup).toBeDefined();
      const newListings = await getListingsByGroupId(newGroup!.id);
      expect(newListings[0]!.name).toBe("Renamed");
      expect(newListings[0]!.date).toBe(sourceListing.date);
    });

    test("rejects a duplicate whose clone name would collide", async () => {
      // A blank find/replace clones the source name verbatim, which would
      // collide with the still-existing source listing — the name invariant
      // rejects it before any write.
      const group = await createTestGroup({ name: "Clashy" });
      await createTestListing({ groupId: group.id, name: "Only Member" });
      await expectDuplicateRejected(group.id, { new_name: "Clashy Copy" });
    });

    test("rejects a new group name already used by another entity", async () => {
      const group = await createTestGroup({ name: "Dup Src" });
      await createTestListing({ groupId: group.id, name: "A Member" });
      await createTestListing({ name: "Taken Name" });
      await expectDuplicateRejected(group.id, {
        name_find: "A Member",
        name_replace: "A Clone",
        new_name: "Taken Name",
      });
    });

    test("rejects when a clone name would equal the new group name", async () => {
      // The new group name and a clone name collide within the batch (both
      // brand-new), which no create-path validator would see — caught up front.
      const group = await createTestGroup({ name: "Collapse" });
      await createTestListing({ groupId: group.id, name: "Sole Member" });
      // The clone is renamed to exactly the new group name.
      await expectDuplicateRejected(group.id, {
        name_find: "Sole Member",
        name_replace: "Shared Name",
        new_name: "Shared Name",
      });
    });

    test("duplicates a large group without tripping the transaction round-trip guard", async () => {
      // 16 listings would be 1 + 16 + 16 = 33 statements in an interactive
      // transaction (guard fires at 30); the single-batch clone must stay clear
      // of it and land every membership row.
      const group = await createTestGroup({ name: "Big" });
      for (let i = 0; i < 16; i++) {
        await createTestListing({ groupId: group.id, name: `Listing ${i}` });
      }

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          // "Listing N" → "Clone N" keeps every clone name unique.
          name_find: "Listing",
          name_replace: "Clone",
          new_name: "Big Copy",
        },
      );

      expect(response.status).toBe(302);
      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Big Copy",
      );
      expect(newGroup).toBeDefined();
      expect((await getListingsByGroupId(newGroup!.id)).length).toBe(16);
    });

    test("rejects an empty new group name with an error flash", async () => {
      const group = await createTestGroup({ name: "Needs Name" });
      await createTestListing({ groupId: group.id, name: "E" });

      const groupCountBefore = (await groups.cache.getAll()).length;

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          name_find: "",
          name_replace: "",
          new_name: "",
        },
      );

      expect(response.status).toBe(302);
      // Redirect back to the form, not on to a new group page
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
      expect((await groups.cache.getAll()).length).toBe(groupCountBefore);
    });

    test("copies the package flag, hide option, and remapped member overrides", async () => {
      const { getGroupDayPrices, getListingDayPrices } = await import(
        "#shared/db/listing-prices.ts"
      );
      const group = await createTestGroup({
        isPackage: true,
        name: "Pkg Source",
      });
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        groupId: group.id,
        listingType: "daily",
        name: "Member",
        unitPrice: 1000,
      });
      // Set a package price override + quantity + per-day override + hide flag
      // on the source group.
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        description: "",
        hide_package_listings: "1",
        is_package: "1",
        max_attendees: "0",
        name: "Pkg Source",
        [`package_day_price_${listing.id}_2`]: "9.00",
        [`package_price_${listing.id}`]: "30.00",
        [`package_qty_${listing.id}`]: "4",
        slug: group.slug,
        terms_and_conditions: "",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          name_find: "Member",
          name_replace: "Cloned Member",
          new_name: "Pkg Copy",
        },
      );
      expect(response.status).toBe(302);

      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Pkg Copy",
      )!;
      expect(newGroup.is_package).toBe(true);
      expect(newGroup.hide_package_listings).toBe(true);
      const newListing = (await getListingsByGroupId(newGroup.id))[0]!;
      expect(newListing.id).not.toBe(listing.id);
      // The clone keeps its OWN per-day-count prices: they are no longer a
      // listings column, so the duplicate carries them through as day_count rows.
      expect(await getListingDayPrices(newListing.id)).toEqual({
        1: 1000,
        2: 1800,
      });
      const prices = await getTestPackagePrices(newGroup.id);
      expect(prices.get(newListing.id)).toBe(3000);
      const newRows = await getGroupPackagePrices(newGroup.id);
      expect(newRows[0]!.quantity).toBe(4);
      // The per-day override is rewritten under the NEW group id and clone id
      // (its price_id embeds the group), so the copy prices identically.
      const newDayPrices = await getGroupDayPrices(newGroup.id);
      expect(newDayPrices.get(newListing.id)?.get(2)).toBe(900);
      // The source override is untouched.
      const sourceRows = await getGroupPackagePrices(group.id);
      expect(sourceRows[0]!.package_price).toBe(3000);
      expect(sourceRows[0]!.quantity).toBe(4);
      expect((await getGroupDayPrices(group.id)).get(listing.id)?.get(2)).toBe(
        900,
      );
    });

    test("returns 404 when the source group does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/groups/999999/bulk-actions/duplicate",
        { new_name: "Orphan" },
      );
      expect(response.status).toBe(404);
    });
  });
});
