import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getGroupPackagePrices } from "#db/groups.ts";
import { listingParents } from "#db/listing-parents.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { exportListing } from "#routes/admin/catalog-transfer/export.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import {
  requireEntityImport,
  unwrapExport,
} from "#test-utils/catalog-import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { featureSetting } from "#test-utils/settings.ts";

/** Import a listing that asks for a built site, and assert the refusal names it. */
const refusePlanImport = async (name: string): Promise<void> => {
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
  expect(result).toMatchObject({
    error: t("catalog_transfer.site_plan_listing_refused", { name }),
    ok: false,
  });
};

const importLogisticsListing = async (name: string): Promise<boolean> => {
  const result = await importCatalog({
    kind: "listing",
    listing: { maxAttendees: 1, name, usesLogistics: true },
    version: 1,
  });
  if (!result.ok) throw new Error(result.error);
  return (await getListingWithCount(requireEntityImport(result).id))!
    .uses_logistics;
};

describeWithEnv(
  "catalog-transfer review fixes",
  {
    db: true,
    env: { CAN_BUILD_SITES: undefined },
  },
  () => {
    test("rejects a zero-capacity listing", async () => {
      const result = await importCatalog({
        kind: "listing",
        listing: { maxAttendees: 0, name: "Zero Cap" },
        version: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      assertStringIncludes(result.error, "listing.maxAttendees");
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
      assertStringIncludes(result.error, "day count");
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
      assertStringIncludes(result.error, "referenced more than once");
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
      const imported = (await getListingWithCount(
        requireEntityImport(result).id,
      ))!;
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
      const imported = (await getListingWithCount(
        requireEntityImport(result).id,
      ))!;
      expect(imported.webhook_url).toBe("https://example.com/hook");
    });

    test("refuses a built-site plan listing whatever the builder configuration", async () => {
      await refusePlanImport("No Builder");
      using _builderOn = withEnv({ CAN_BUILD_SITES: "true" });
      await refusePlanImport("Builder On");
    });

    test("clears uses-logistics when logistics is disabled", async () => {
      expect(await importLogisticsListing("Logi Off")).toBe(false);
    });

    test("keeps uses-logistics when logistics is enabled", async () => {
      settings.setForTest(featureSetting("logistics"));
      expect(await importLogisticsListing("Logi On")).toBe(true);
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
        (r) => r.listing_id === requireEntityImport(result).id,
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
      const row = (
        await getGroupPackagePrices(requireEntityImport(result).id)
      )[0]!;
      expect(row.package_price).toBeNull();
      expect(row.quantity).toBe(1);
    });

    test("rejects a parent that is a hidden-package member", async () => {
      const pkg = await createTestGroup({
        isPackage: true,
        name: "Hidden Pkg",
      });
      // createTestGroup can't set hide_package_listings, so set it directly and
      // refresh the cached group set the import reads.
      await execute(
        "UPDATE groups SET hide_package_listings = 1 WHERE id = ?",
        [pkg.id],
      );
      const { groups } = await import("#db/groups.ts");
      groups.cache.invalidate();
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
      assertStringIncludes(result.error, "package hides listing names");
    });

    test("imports a listing with many parents in one batched insert", async () => {
      // More parents than the per-request N+1 guard (25) and the transaction
      // round-trip cap (~30) would allow one query/insert each — proves the
      // batched nested-parent check and the set-wise edge insert.
      const { listingsTable } = await import("#db/listings/records.ts");
      const { hmacHash } = await import("#crypto/hashing.ts");
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
          slugIndex: await hmacHash(slug),
        });
      }
      const result = await importCatalog({
        kind: "listing",
        listing: { maxAttendees: 1, name: "Many Kids" },
        parents: parentNames,
        version: 1,
      });
      if (!result.ok) throw new Error(result.error);
      expect(
        (await listingParents.getIds(requireEntityImport(result).id)).length,
      ).toBe(30);
    });

    test("imports a listing that belongs to many groups", async () => {
      // More groups than the per-request N+1 guard (25) would allow one
      // compatibility SELECT each — proves group-compat validation batch-loads the
      // siblings for every referenced group instead of one query per group. Insert
      // the groups directly (like the many-parents case) rather than via
      // createTestGroup, whose trailing getAllGroups() would itself trip the read
      // guard 30 times over in this one test context.
      const { groups } = await import("#db/groups.ts");
      const { hmacHash } = await import("#crypto/hashing.ts");
      const groupNames = Array.from({ length: 30 }, (_, i) => `Group ${i}`);
      for (const name of groupNames) {
        const slug = name.toLowerCase().replace(/\s+/g, "-");
        await groups.table.insert({
          name,
          slug,
          slugIndex: await hmacHash(slug),
        });
      }
      const result = await importCatalog({
        groups: groupNames.map((group) => ({ group })),
        kind: "listing",
        listing: { maxAttendees: 1, name: "Joins Many" },
        version: 1,
      });
      if (!result.ok) throw new Error(result.error);
      expect(
        (await listingGroups.getIds(requireEntityImport(result).id)).length,
      ).toBe(30);
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
      expect(
        (await listingParents.getIds(requireEntityImport(result).id)).length,
      ).toBe(1);
      expect(
        (await listingGroups.getIds(requireEntityImport(result).id)).length,
      ).toBe(1);
    });

    test("hides the webhook URL from an editor export", async () => {
      const listing = await createTestListing({
        name: "Hooked",
        webhookUrl: "https://example.com/hook",
      });
      // The editor blob must not carry the PII sink URL the edit form hides…
      const editorBlob = unwrapExport(
        await exportListing(listing.id, "editor"),
      );
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
  },
);

describeWithEnv("catalog-transfer branch coverage", { db: true }, () => {
  test("rejects an ambiguous (duplicate-named) reference", async () => {
    const { listingsTable } = await import("#db/listings/records.ts");
    const { hmacHash } = await import("#crypto/hashing.ts");
    for (const slug of ["twin-a", "twin-b"]) {
      await listingsTable.insert({
        maxAttendees: 1,
        maxPrice: 0,
        name: "Twin Parent",
        slug,
        slugIndex: await hmacHash(slug),
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
    assertStringIncludes(result.error, "names must be unique to import");
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
    assertStringIncludes(result.error, "same type");
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
    assertStringIncludes(result.error, "already exists");
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
    assertStringIncludes(result.error, "customisable days");
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
    assertStringIncludes(result.error, "Packages cannot contain");
  });
});
