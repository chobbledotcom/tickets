import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllGroups,
  getGroupIdsByListingId,
  getGroupPackagePrices,
  getListingsByGroupId,
} from "#shared/db/groups.ts";
import {
  getAllListings,
  getListingWithCount,
  getStoredListingWithCount,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  getBulkActionForm,
  getTestPackagePrices,
} from "#test-utils";

const getDuplicateForm = getBulkActionForm("duplicate");

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

      const groupCountBefore = (await getAllGroups()).length;
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

      const groupsAfter = await getAllGroups();
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
        new_name: "Inherits copy",
      });

      const newGroup = (await getAllGroups()).find(
        (g) => g.name === "Inherits copy",
      )!;
      const clone = (await getListingsByGroupId(newGroup.id))[0]!;
      // The clone's OWN stored hidden is the source's stored false, not the
      // Hidden=Yes default — so clearing the default later won't strand it.
      expect((await getStoredListingWithCount(clone.id))?.hidden).toBe(false);
    });

    test("duplicates with no replacements copies names and dates verbatim", async () => {
      const group = await createTestGroup({ name: "Verbatim" });
      const sourceListing = await createTestListing({
        date: "2026-05-01T10:00",
        groupId: group.id,
        name: "Untouched",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          name_find: "",
          name_replace: "",
          new_name: "Verbatim Copy",
        },
      );

      expect(response.status).toBe(302);
      const newGroup = (await getAllGroups()).find(
        (g) => g.name === "Verbatim Copy",
      );
      expect(newGroup).toBeDefined();
      const newListings = await getListingsByGroupId(newGroup!.id);
      expect(newListings[0]!.name).toBe("Untouched");
      expect(newListings[0]!.date).toBe(sourceListing.date);
    });

    test("rejects an empty new group name with an error flash", async () => {
      const group = await createTestGroup({ name: "Needs Name" });
      await createTestListing({ groupId: group.id, name: "E" });

      const groupCountBefore = (await getAllGroups()).length;

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
      expect((await getAllGroups()).length).toBe(groupCountBefore);
    });

    test("copies the package flag, hide option, and remapped member overrides", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Pkg Source",
      });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Member",
      });
      // Set a package price override + quantity + hide flag on the source group.
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        description: "",
        hide_package_listings: "1",
        is_package: "1",
        max_attendees: "0",
        name: "Pkg Source",
        [`package_price_${listing.id}`]: "30.00",
        [`package_qty_${listing.id}`]: "4",
        slug: group.slug,
        terms_and_conditions: "",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        { new_name: "Pkg Copy" },
      );
      expect(response.status).toBe(302);

      const newGroup = (await getAllGroups()).find(
        (g) => g.name === "Pkg Copy",
      )!;
      expect(newGroup.is_package).toBe(true);
      expect(newGroup.hide_package_listings).toBe(true);
      const newListing = (await getListingsByGroupId(newGroup.id))[0]!;
      expect(newListing.id).not.toBe(listing.id);
      const prices = await getTestPackagePrices(newGroup.id);
      expect(prices.get(newListing.id)).toBe(3000);
      const newRows = await getGroupPackagePrices(newGroup.id);
      expect(newRows[0]!.quantity).toBe(4);
      // The source override is untouched.
      const sourceRows = await getGroupPackagePrices(group.id);
      expect(sourceRows[0]!.package_price).toBe(3000);
      expect(sourceRows[0]!.quantity).toBe(4);
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
