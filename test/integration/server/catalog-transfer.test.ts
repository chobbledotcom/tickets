import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getGroupPackagePrices, setGroupPackageMembers } from "#db/groups.ts";
import { listingChildren, listingParents } from "#db/listing-parents.ts";
import { getGroupDayPrices } from "#db/listing-prices.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  exportGroup,
  exportListing,
} from "#routes/admin/catalog-transfer/export.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import {
  requireEntityImport,
  unwrapExport,
} from "#test-utils/catalog-import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
      await listingChildren.setIds(parent.id, [child.id]);

      const blob = unwrapExport(await exportListing(child.id));
      expect(blob.kind).toBe("listing");
      expect(blob.parents).toEqual(["Parent Listing"]);
      expect(blob.groups).toEqual([{ group: "Regular Group" }]);
      expect(blob.listing.unitPrice).toBe(1500);

      // Rename and re-import as a fresh listing referencing the same facets.
      blob.listing.name = "Child Copy";
      const result = await importCatalog(blob);
      expect(result).toEqual({
        ok: true,
        value: {
          id: expect.any(Number),
          kind: "listing",
          name: "Child Copy",
        },
      });
      if (!result.ok) throw new Error("unreachable");

      const imported = (await getListingWithCount(
        requireEntityImport(result).id,
      ))!;
      expect(imported.name).toBe("Child Copy");
      expect(imported.unit_price).toBe(1500);
      // Slug is freshly minted, never copied from the source.
      expect(imported.slug).not.toBe(child.slug);
      expect(
        await listingGroups.getIds(requireEntityImport(result).id),
      ).toEqual([group.id]);
      expect(
        await listingParents.getIds(requireEntityImport(result).id),
      ).toEqual([parent.id]);
    });

    test("preserves a child's bookable-alone standalone page", async () => {
      const parent = await createTestListing({ name: "Alone Parent" });
      const child = await createTestListing({
        bookableAlone: true,
        name: "Alone Child",
      });
      await listingChildren.setIds(parent.id, [child.id]);

      const blob = unwrapExport(await exportListing(child.id));
      // The flag must survive the export (otherwise import defaults it to false).
      expect(blob.listing.bookableAlone).toBe(true);

      blob.listing.name = "Alone Copy";
      const result = await importCatalog(blob);
      const importedResult = requireEntityImport(result);
      const imported = (await getListingWithCount(importedResult.id))!;
      expect(imported.bookable_alone).toBe(true);
    });

    test("carries a listing's own stored cells, not resolved site defaults", async () => {
      // Export/import mirror database cells, never the read-time overlay. A site
      // default of hidden=true is in force, but the imported listing sets its OWN
      // cell to hidden=false with useDefaults=true — the operator's call, even
      // though it conflicts with the default and is inert while use_defaults is
      // on. The export must then reflect that cell (false), not the resolved
      // default (true) a cache read would overlay.
      await settings.update.listingDefaults({ hidden: true });
      const created = await importCatalog({
        kind: "listing",
        listing: {
          hidden: false,
          maxAttendees: 5,
          name: "Defaulter",
          thankYouUrl: "https://thanks.example.com",
          useDefaults: true,
        },
        version: 1,
      });
      if (!created.ok) throw new Error(created.error);

      const blob = unwrapExport(
        await exportListing(requireEntityImport(created).id),
      );
      expect(blob.listing.useDefaults).toBe(true);
      // The row's own cell (false), not the resolved default (true).
      expect(blob.listing.hidden).toBe(false);
      expect(blob.listing.thankYouUrl).toBe("https://thanks.example.com");
    });

    test("rejects stale listing image fields", async () => {
      const staleFields = [
        ["imageThumbUrl", "legacy-thumb.webp"],
        ["imageUrl", "legacy.webp"],
      ] as const;
      for (const [field, value] of staleFields) {
        const result = await importCatalog({
          kind: "listing",
          listing: {
            [field]: value,
            maxAttendees: 5,
            name: `Legacy ${field} Import`,
          },
          version: 1,
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        assertStringIncludes(result.error, `listing.${field}`);
      }
    });

    test("preserves closesAt and re-syncs the derived price rows", async () => {
      const result = await importCatalog({
        kind: "listing",
        listing: {
          closesAt: "2030-01-01T00:00:00.000Z",
          maxAttendees: 5,
          name: "Priced Import",
          unitPrice: 2500,
        },
        version: 1,
      });
      if (!result.ok) throw new Error(result.error);

      const imported = (await getListingWithCount(
        requireEntityImport(result).id,
      ))!;
      expect(imported.closes_at).toBe("2030-01-01T00:00:00.000Z");
      // The derived listing_prices base row is re-synced from unit_price after
      // the transactional insert (which bypasses the table wrapper).
      const priceRows = await execute(
        "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = 'base'",
        [requireEntityImport(result).id],
      );
      expect(priceRows.rows.map((r) => Number(r.unit_price))).toEqual([2500]);
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
        maxQuantity: 3,
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

      const blob = unwrapExport(await exportListing(member.id));
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
      const importedRow = rows.find(
        (r) => r.listing_id === requireEntityImport(result).id,
      )!;
      expect(importedRow.package_price).toBe(800);
      expect(importedRow.quantity).toBe(3);
      const dayPrices = await getGroupDayPrices(group.id);
      expect(dayPrices.get(requireEntityImport(result).id)).toEqual(
        new Map([[1, 900]]),
      );
      // The existing member's overrides are untouched by the targeted insert.
      expect(rows.find((r) => r.listing_id === member.id)?.package_price).toBe(
        800,
      );
    });
  });

  describe("group round-trip", () => {
    test("re-creates a package group with its members and overrides", async () => {
      const a = await createTestListing({
        maxQuantity: 2,
        name: "Pkg A",
        unitPrice: 1000,
      });
      const b = await createTestListing({ name: "Pkg B", unitPrice: 2000 });
      // A member that is explicitly FREE in the package (price 0) — distinct
      // from "no override" (null); the two must round-trip separately.
      const c = await createTestListing({ name: "Pkg C", unitPrice: 3000 });
      const group = await createTestGroup({ isPackage: true, name: "Combo" });
      await assignListingsToGroup([a.id, b.id, c.id], group.id);
      await setGroupPackageMembers(group.id, [
        { listingId: a.id, price: 800, quantity: 2 },
        { listingId: b.id, price: null, quantity: 1 },
        { listingId: c.id, price: 0, quantity: 1 },
      ]);

      const blob = unwrapExport(await exportGroup(group.id));
      expect(blob.group.isPackage).toBe(true);
      expect(blob.members).toEqual([
        { listing: "Pkg A", packagePrice: 800, quantity: 2 },
        { listing: "Pkg B" },
        { listing: "Pkg C", packagePrice: 0 },
      ]);

      blob.group.name = "Combo Copy";
      const result = await importCatalog(blob);
      if (!result.ok) throw new Error(result.error);
      expect(result.value.kind).toBe("group");

      const rows = await getGroupPackagePrices(requireEntityImport(result).id);
      expect(rows).toEqual([
        {
          group_id: requireEntityImport(result).id,
          listing_id: a.id,
          package_price: 800,
          quantity: 2,
        },
        {
          group_id: requireEntityImport(result).id,
          listing_id: b.id,
          package_price: null,
          quantity: 1,
        },
        {
          group_id: requireEntityImport(result).id,
          listing_id: c.id,
          package_price: 0,
          quantity: 1,
        },
      ]);
    });
  });

  describe("import validation", () => {
    test("rejects a listing whose name already exists", async () => {
      const listing = await createTestListing({ name: "Existing" });
      const blob = unwrapExport(await exportListing(listing.id));
      const result = await importCatalog(blob);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error, 'named "Existing" already exists');
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
      assertStringIncludes(result.error, 'No listing named "Missing Parent"');
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
      assertStringIncludes(result.error, 'No group named "Ghost Group"');
    });

    test("rejects a package join whose pick count passes the listing's cap", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Capped Pkg",
      });
      await createTestListing({ groupId: group.id, name: "Seated Member" });

      const result = await importCatalog({
        groups: [{ group: "Capped Pkg", quantity: 5 }],
        kind: "listing",
        listing: { maxAttendees: 2, maxQuantity: 2, name: "Overpicky" },
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toBe(
        t("error.package_member_cap", {
          max_quantity: 2,
          name: "Overpicky",
          quantity: 5,
        }),
      );
    });

    test("reports missing required fields with field names", async () => {
      const result = await importCatalog({
        kind: "listing",
        listing: {},
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error, "listing.name");
      assertStringIncludes(result.error, "listing.maxAttendees");
    });

    test("rejects an unsupported version", async () => {
      const result = await importCatalog({
        kind: "listing",
        listing: { maxAttendees: 1, name: "V2" },
        version: 2,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error, "Unsupported export version");
    });

    test("rejects a blob with an unknown kind (nested field message)", async () => {
      const result = await importCatalog({ kind: "widget" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error, "kind:");
      assertStringIncludes(result.error, "listing");
    });

    test("rejects a blob that is not an object (root type message)", async () => {
      const result = await importCatalog(42);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error, "Invalid catalog file — Invalid type");
      assertStringIncludes(result.error, "Object");
    });

    test("rejects a blob with an unknown relationship key", async () => {
      // `parent` (singular) is not a known key. The format is versioned and
      // exact-version gated, so a misspelled relationship key must be a field
      // error, not silently imported as a standalone listing with no parents.
      const result = await importCatalog({
        kind: "listing",
        listing: { maxAttendees: 5, name: "Typo Kid" },
        parent: ["Whatever"],
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error, "parent");
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
      assertStringIncludes(result.error, 'No listing named "No Such Listing"');
    });

    test("rejects a listing whose parent edge is incompatible", async () => {
      // A daily child cannot sit under a standard parent (the child inherits the
      // parent's date, which a standard listing has none of) — validateParentEdges
      // reuses the edge editor's rule and must reject the import.
      await createTestListing({ listingType: "standard", name: "Std Parent" });
      const result = await importCatalog({
        kind: "listing",
        listing: { listingType: "daily", maxAttendees: 10, name: "Daily Kid" },
        parents: ["Std Parent"],
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error.toLowerCase(), "daily");
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
      assertStringIncludes(result.error, "must be the same type");
    });
  });

  test("exporting a missing listing or group returns null", async () => {
    expect(await exportListing(9999)).toBeNull();
    expect(await exportGroup(9999)).toBeNull();
  });
});
