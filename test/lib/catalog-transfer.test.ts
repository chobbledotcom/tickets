import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  exportGroup,
  exportListing,
} from "#routes/admin/catalog-transfer/export.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import {
  assignListingsToGroup,
  getGroupIdsByListingId,
  getGroupPackagePrices,
  setGroupPackageMembers,
} from "#shared/db/groups.ts";
import { getParentIds, setChildIds } from "#shared/db/listing-parents.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import { getListing } from "#shared/db/listings.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("catalog-transfer", { db: true }, () => {
  describe("listing round-trip", () => {
    test("re-creates a listing with its group membership and parent", async () => {
      const group = await createTestGroup({ name: "Regular Group" });
      const parent = await createTestListing({
        name: "Parent Listing",
        unitPrice: 5000,
      });
      const child = await createTestListing({
        groupId: group.id,
        name: "Child Listing",
        unitPrice: 1500,
      });
      await setChildIds(parent.id, [child.id]);

      const blob = (await exportListing(child.id))!;
      expect(blob.kind).toBe("listing");
      expect(blob.parents).toEqual(["Parent Listing"]);
      expect(blob.groups).toEqual([{ group: "Regular Group" }]);
      expect(blob.listing.unitPrice).toBe(1500);

      // Rename and re-import as a fresh listing referencing the same facets.
      blob.listing.name = "Child Copy";
      const result = await importCatalog(blob);
      expect(result).toEqual({
        id: expect.any(Number),
        kind: "listing",
        name: "Child Copy",
        ok: true,
      });
      if (!result.ok) throw new Error("unreachable");

      const imported = (await getListing(result.id))!;
      expect(imported.name).toBe("Child Copy");
      expect(imported.unit_price).toBe(1500);
      // Slug is freshly minted, never copied from the source.
      expect(imported.slug).not.toBe(child.slug);
      expect(await getGroupIdsByListingId(result.id)).toEqual([group.id]);
      expect(await getParentIds(result.id)).toEqual([parent.id]);
    });

    test("carries package overrides and day prices for a package member", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Bundle",
      });
      const member = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        groupId: group.id,
        name: "Flexi Member",
      });
      await setGroupPackageMembers(group.id, [
        {
          dayPrices: { 1: 900 },
          listingId: member.id,
          price: 800,
          quantity: 3,
        },
      ]);

      const blob = (await exportListing(member.id))!;
      expect(blob.groups).toEqual([
        {
          dayPrices: { "1": 900 },
          group: "Bundle",
          packagePrice: 800,
          quantity: 3,
        },
      ]);
      expect(blob.listing.dayPrices).toEqual({ "1": 1000, "2": 1800 });

      blob.listing.name = "Flexi Copy";
      const result = await importCatalog(blob);
      if (!result.ok) throw new Error(result.error);

      const rows = await getGroupPackagePrices(group.id);
      const importedRow = rows.find((r) => r.listing_id === result.id)!;
      expect(importedRow.package_price).toBe(800);
      expect(importedRow.quantity).toBe(3);
      const dayPrices = await getGroupDayPrices(group.id);
      expect(dayPrices.get(result.id)).toEqual(new Map([[1, 900]]));
      // The existing member's overrides are untouched by the targeted insert.
      expect(rows.find((r) => r.listing_id === member.id)?.package_price).toBe(
        800,
      );
    });
  });

  describe("group round-trip", () => {
    test("re-creates a package group with its members and overrides", async () => {
      const a = await createTestListing({ name: "Pkg A", unitPrice: 1000 });
      const b = await createTestListing({ name: "Pkg B", unitPrice: 2000 });
      const group = await createTestGroup({ isPackage: true, name: "Combo" });
      await assignListingsToGroup([a.id, b.id], group.id);
      await setGroupPackageMembers(group.id, [
        { listingId: a.id, price: 800, quantity: 2 },
        { listingId: b.id, price: null, quantity: 1 },
      ]);

      const blob = (await exportGroup(group.id))!;
      expect(blob.group.isPackage).toBe(true);
      expect(blob.members).toEqual([
        { listing: "Pkg A", packagePrice: 800, quantity: 2 },
        { listing: "Pkg B" },
      ]);

      blob.group.name = "Combo Copy";
      const result = await importCatalog(blob);
      if (!result.ok) throw new Error(result.error);
      expect(result.kind).toBe("group");

      const rows = await getGroupPackagePrices(result.id);
      expect(rows).toEqual([
        {
          group_id: result.id,
          listing_id: a.id,
          package_price: 800,
          quantity: 2,
        },
        {
          group_id: result.id,
          listing_id: b.id,
          package_price: null,
          quantity: 1,
        },
      ]);
    });
  });

  describe("import validation", () => {
    test("rejects a listing whose name already exists", async () => {
      const listing = await createTestListing({ name: "Existing" });
      const blob = (await exportListing(listing.id))!;
      const result = await importCatalog(blob);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain('named "Existing" already exists');
    });

    test("rejects a listing whose parent does not exist", async () => {
      const result = await importCatalog({
        kind: "listing",
        listing: { maxAttendees: 10, name: "Orphan" },
        parents: ["Missing Parent"],
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain('No listing named "Missing Parent"');
    });

    test("rejects a listing whose group does not exist", async () => {
      const result = await importCatalog({
        groups: [{ group: "Ghost Group" }],
        kind: "listing",
        listing: { maxAttendees: 10, name: "Joiner" },
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain('No group named "Ghost Group"');
    });

    test("reports missing required fields with field names", async () => {
      const result = await importCatalog({
        kind: "listing",
        listing: {},
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("listing.name");
      expect(result.error).toContain("listing.maxAttendees");
    });

    test("rejects an unsupported version", async () => {
      const result = await importCatalog({
        kind: "listing",
        listing: { maxAttendees: 1, name: "V2" },
        version: 2,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("Unsupported export version");
    });

    test("rejects a blob that is not a listing or group export", async () => {
      const result = await importCatalog({ kind: "widget" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("Invalid catalog file");
    });

    test("rejects a group whose member listing does not exist", async () => {
      const result = await importCatalog({
        group: { name: "New Bundle" },
        kind: "group",
        members: [{ listing: "No Such Listing" }],
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain('No listing named "No Such Listing"');
    });

    test("rejects a group whose members are not the same type", async () => {
      await createTestListing({ listingType: "standard", name: "Std" });
      await createTestListing({ listingType: "daily", name: "Daily" });
      const result = await importCatalog({
        group: { name: "Mixed" },
        kind: "group",
        members: [{ listing: "Std" }, { listing: "Daily" }],
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("must be the same type");
    });
  });

  test("exporting a missing listing or group returns null", async () => {
    expect(await exportListing(9999)).toBeNull();
    expect(await exportGroup(9999)).toBeNull();
  });
});
