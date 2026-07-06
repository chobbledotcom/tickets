import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  CatalogExportError,
  exportGroup,
  exportListing,
} from "#routes/admin/catalog-transfer/export.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { execute } from "#shared/db/client.ts";
import {
  assignListingsToGroup,
  getGroupIdsByListingId,
  getGroupPackagePrices,
  setGroupPackageMembers,
} from "#shared/db/groups.ts";
import { listingChildren, listingParents } from "#shared/db/listing-parents.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import { getListing } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

/** Unwrap a successful export, failing if it returned null or an
 * (unexpected-in-these-tests) {@link CatalogExportError}. */
const unwrapExport = <T>(blob: T | CatalogExportError | null): T => {
  if (blob instanceof CatalogExportError) throw new Error(blob.message);
  if (blob === null) throw new Error("export returned null");
  return blob;
};

/** Import a listing that asks for a built site, returning the persisted
 * `assign_built_site` flag — true only where the builder is configured. */
const importBuiltSiteListing = async (name: string): Promise<boolean> => {
  const result = await importCatalog({
    kind: "listing",
    listing: {
      assignBuiltSite: true,
      initialSiteMonths: 12,
      maxAttendees: 5,
      name,
    },
    version: 1,
  });
  if (!result.ok) throw new Error(result.error);
  return (await getListing(result.id))!.assign_built_site;
};

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
      expect(await listingParents.getIds(result.id)).toEqual([parent.id]);
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
      if (!result.ok) throw new Error(result.error);
      const imported = (await getListing(result.id))!;
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

      const blob = unwrapExport(await exportListing(created.id));
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
        expect(result.error).toContain(`listing.${field}`);
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

      const imported = (await getListing(result.id))!;
      expect(imported.closes_at).toBe("2030-01-01T00:00:00.000Z");
      // The derived listing_prices base row is re-synced from unit_price after
      // the transactional insert (which bypasses the table wrapper).
      const priceRows = await execute(
        "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = 'base'",
        [result.id],
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
        {
          group_id: result.id,
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

    test("rejects a blob with an unknown kind (nested field message)", async () => {
      const result = await importCatalog({ kind: "widget" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("kind:");
      expect(result.error).toContain("listing");
    });

    test("rejects a blob that is not an object (root type message)", async () => {
      const result = await importCatalog(42);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("Invalid catalog file — Invalid type");
      expect(result.error).toContain("Object");
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
      expect(result.error).toContain("parent");
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
      expect(result.error.toLowerCase()).toContain("daily");
    });

    test("rejects a listing that is both a package member and a child", async () => {
      const pkg = await createTestGroup({ isPackage: true, name: "Pkg Group" });
      await createTestListing({ name: "Some Parent" });
      const result = await importCatalog({
        groups: [{ group: "Pkg Group" }],
        kind: "listing",
        listing: { maxAttendees: 10, name: "Torn" },
        parents: ["Some Parent"],
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error).toContain("cannot also be an add-on child");
      // Reference the created package so the binding is used.
      expect(pkg.is_package).toBe(true);
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

describeWithEnv("catalog-transfer review fixes", { db: true }, () => {
  test("rejects a zero-capacity listing", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 0, name: "Zero Cap" },
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("listing.maxAttendees");
  });

  test("rejects a day-price key that is not a day count", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: {
        dayPrices: { weekday: 100 },
        maxAttendees: 1,
        name: "Bad Day",
      },
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("day count");
  });

  test("rejects a duplicate parent reference", async () => {
    await createTestListing({ name: "Dup Parent" });
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Dup Child" },
      parents: ["Dup Parent", "Dup Parent"],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("referenced more than once");
  });

  test("rejects a parent that is itself a child (single-level nesting)", async () => {
    const grandparent = await createTestListing({ name: "Grandparent" });
    const parent = await createTestListing({ name: "Middle" });
    await listingChildren.setIds(grandparent.id, [parent.id]);
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Deep Child" },
      parents: ["Middle"],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("offered as a child");
  });

  test("strips webhook URL and use-defaults for an editor import", async () => {
    const result = await importCatalog(
      {
        kind: "listing",
        listing: {
          maxAttendees: 5,
          name: "Editor Listing",
          useDefaults: true,
          webhookUrl: "https://example.com/hook",
        },
        version: 1,
      },
      "editor",
    );
    if (!result.ok) throw new Error(result.error);
    const imported = (await getListing(result.id))!;
    expect(imported.webhook_url).toBe("");
    expect(imported.use_defaults).toBe(false);
  });

  test("keeps the webhook URL for a non-editor import", async () => {
    const result = await importCatalog(
      {
        kind: "listing",
        listing: {
          maxAttendees: 5,
          name: "Owner Listing",
          webhookUrl: "https://example.com/hook",
        },
        version: 1,
      },
      "owner",
    );
    if (!result.ok) throw new Error(result.error);
    const imported = (await getListing(result.id))!;
    expect(imported.webhook_url).toBe("https://example.com/hook");
  });

  test("clears assign-built-site when the builder is not configured", async () => {
    expect(await importBuiltSiteListing("No Builder")).toBe(false);
  });

  test("clears uses-logistics when logistics is disabled", async () => {
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Logi Off", usesLogistics: true },
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect((await getListing(result.id))!.uses_logistics).toBe(false);
  });

  test("keeps uses-logistics when logistics is enabled", async () => {
    settings.setForTest({ has_logistics: true });
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Logi On", usesLogistics: true },
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect((await getListing(result.id))!.uses_logistics).toBe(true);
  });

  test("clears package overrides for a non-package group membership", async () => {
    const group = await createTestGroup({ name: "Regular Group" });
    const result = await importCatalog({
      groups: [{ group: "Regular Group", packagePrice: 500, quantity: 3 }],
      kind: "listing",
      listing: { maxAttendees: 1, name: "Joiner", unitPrice: 900 },
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    const row = (await getGroupPackagePrices(group.id)).find(
      (r) => r.listing_id === result.id,
    )!;
    // The override is dropped because the group isn't a package.
    expect(row.package_price).toBeNull();
    expect(row.quantity).toBe(1);
  });

  test("clears member overrides when importing a non-package group", async () => {
    await createTestListing({ name: "Plain Member", unitPrice: 800 });
    const result = await importCatalog({
      group: { name: "Plain Group" },
      kind: "group",
      members: [{ listing: "Plain Member", packagePrice: 200, quantity: 5 }],
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    const row = (await getGroupPackagePrices(result.id))[0]!;
    expect(row.package_price).toBeNull();
    expect(row.quantity).toBe(1);
  });

  test("rejects a parent that is a hidden-package member", async () => {
    const pkg = await createTestGroup({ isPackage: true, name: "Hidden Pkg" });
    // createTestGroup can't set hide_package_listings, so set it directly and
    // refresh the cached group set the import reads.
    await execute("UPDATE groups SET hide_package_listings = 1 WHERE id = ?", [
      pkg.id,
    ]);
    const { invalidateGroupsCache } = await import("#shared/db/groups.ts");
    invalidateGroupsCache();
    const parent = await createTestListing({ name: "Pkg Parent" });
    await assignListingsToGroup([parent.id], pkg.id);
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Kid" },
      parents: ["Pkg Parent"],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("hidden package");
  });

  test("imports a listing with many parents in one batched insert", async () => {
    // More parents than the per-request N+1 guard (25) and the transaction
    // round-trip cap (~30) would allow one query/insert each — proves the
    // batched nested-parent check and the set-wise edge insert.
    const { computeSlugIndex, listingsTable } = await import(
      "#shared/db/listings.ts"
    );
    const parentNames = Array.from({ length: 30 }, (_, i) => `Parent ${i}`);
    for (const name of parentNames) {
      const slug = name.toLowerCase().replace(/\s+/g, "-");
      await listingsTable.insert({
        // Supply dayPrices so insert doesn't read them back per row (which would
        // trip the N+1 guard across this 30-row setup loop).
        dayPrices: {},
        maxAttendees: 1,
        maxPrice: 0,
        name,
        slug,
        slugIndex: await computeSlugIndex(slug),
      });
    }
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Many Kids" },
      parents: parentNames,
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect((await listingParents.getIds(result.id)).length).toBe(30);
  });

  test("imports a listing that belongs to many groups", async () => {
    // More groups than the per-request N+1 guard (25) would allow one
    // compatibility SELECT each — proves group-compat validation batch-loads the
    // siblings for every referenced group instead of one query per group. Insert
    // the groups directly (like the many-parents case) rather than via
    // createTestGroup, whose trailing getAllGroups() would itself trip the read
    // guard 30 times over in this one test context.
    const { computeGroupSlugIndex, groupsTable } = await import(
      "#shared/db/groups.ts"
    );
    const groupNames = Array.from({ length: 30 }, (_, i) => `Group ${i}`);
    for (const name of groupNames) {
      const slug = name.toLowerCase().replace(/\s+/g, "-");
      await groupsTable.insert({
        name,
        slug,
        slugIndex: await computeGroupSlugIndex(slug),
      });
    }
    const result = await importCatalog({
      groups: groupNames.map((group) => ({ group })),
      kind: "listing",
      listing: { maxAttendees: 1, name: "Joins Many" },
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect((await getGroupIdsByListingId(result.id)).length).toBe(30);
  });

  test("imports a child listing that also belongs to a regular group", async () => {
    // A child (has a parent) that joins a non-package group exercises the
    // package-membership guard over a real, non-package group set — it must find
    // no package and let the parent edge through.
    await createTestListing({ name: "Edge Parent" });
    await createTestGroup({ name: "Plain Joiner Group" });
    const result = await importCatalog({
      groups: [{ group: "Plain Joiner Group" }],
      kind: "listing",
      listing: { maxAttendees: 1, name: "Grouped Kid" },
      parents: ["Edge Parent"],
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
    expect((await listingParents.getIds(result.id)).length).toBe(1);
    expect((await getGroupIdsByListingId(result.id)).length).toBe(1);
  });

  test("hides the webhook URL from an editor export", async () => {
    const listing = await createTestListing({
      name: "Hooked",
      webhookUrl: "https://example.com/hook",
    });
    // The editor blob must not carry the PII sink URL the edit form hides…
    const editorBlob = unwrapExport(await exportListing(listing.id, "editor"));
    expect(editorBlob.listing.webhookUrl).toBeUndefined();
    // …but staff still round-trip it.
    const ownerBlob = unwrapExport(await exportListing(listing.id, "owner"));
    expect(ownerBlob.listing.webhookUrl).toBe("https://example.com/hook");
  });

  test("batches many memberships into at most two statements", async () => {
    // The interactive transaction caps at 30 statements, so a large group's
    // memberships must not be one statement each. membershipStatements collapses
    // them into one group_listings insert plus one group_day insert.
    const { membershipStatements } = await import(
      "#routes/admin/catalog-transfer/membership.ts"
    );
    const memberships = Array.from({ length: 40 }, (_, i) => ({
      dayPrices: { 1: 500 },
      groupId: 7,
      listingId: i + 1,
      packagePrice: null,
      quantity: 1,
    }));
    const statements = membershipStatements(memberships);
    expect(statements.length).toBe(2);
    // Every member appears in the single group_listings insert (3 args each:
    // group_id, listing_id, quantity — the flat price override, when present,
    // lives in the separate listing_prices insert).
    expect(statements[0]!.args.length).toBe(40 * 3);
  });
});

describeWithEnv(
  "catalog-transfer with the builder enabled",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("keeps assign-built-site when the builder is configured", async () => {
      expect(await importBuiltSiteListing("Builder On")).toBe(true);
    });
  },
);

describeWithEnv("catalog-transfer branch coverage", { db: true }, () => {
  test("rejects an ambiguous (duplicate-named) reference", async () => {
    const { computeSlugIndex, listingsTable } = await import(
      "#shared/db/listings.ts"
    );
    for (const slug of ["twin-a", "twin-b"]) {
      await listingsTable.insert({
        maxAttendees: 1,
        maxPrice: 0,
        name: "Twin Parent",
        slug,
        slugIndex: await computeSlugIndex(slug),
      });
    }
    const result = await importCatalog({
      kind: "listing",
      listing: { maxAttendees: 1, name: "Ambiguous Child" },
      parents: ["Twin Parent"],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("names must be unique to import");
  });

  test("surfaces a listing-validation error (group type mismatch)", async () => {
    const group = await createTestGroup({ name: "Std Group" });
    await createTestListing({
      groupId: group.id,
      listingType: "standard",
      name: "Std Member",
    });
    const result = await importCatalog({
      groups: [{ group: "Std Group" }],
      kind: "listing",
      listing: { listingType: "daily", maxAttendees: 5, name: "Daily Joiner" },
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("same type");
  });

  test("rejects a group name already in use", async () => {
    await createTestGroup({ name: "Taken Group" });
    const result = await importCatalog({
      group: { name: "Taken Group" },
      kind: "group",
      members: [],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("already exists");
  });

  test("rejects group members that disagree on customisable days", async () => {
    await createTestListing({ listingType: "standard", name: "Fixed Days" });
    await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      durationDays: 1,
      listingType: "standard",
      name: "Flexible Days",
    });
    const result = await importCatalog({
      group: { name: "Mixed Days" },
      kind: "group",
      members: [{ listing: "Fixed Days" }, { listing: "Flexible Days" }],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("customisable days");
  });

  test("rejects a package group with a non-packageable member", async () => {
    await createTestListing({
      canPayMore: true,
      maxPrice: 5000,
      name: "Pay What You Want",
      unitPrice: 1000,
    });
    const result = await importCatalog({
      group: { isPackage: true, name: "Bad Package" },
      kind: "group",
      members: [{ listing: "Pay What You Want" }],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("Packages cannot contain");
  });
});
