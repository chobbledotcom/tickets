import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#crypto/sealed.ts";
import { execute } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getGroupPackagePrices, newGroupValues } from "#db/groups.ts";
import { listingParents } from "#db/listing-parents.ts";
import { createListing, getListingWithCount } from "#db/listings/records.ts";
import { records } from "#db/record-table.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { t } from "#i18n";
import { exportListing } from "#routes/admin/catalog-transfer/export.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import {
  importedListing,
  requireEntityImport,
  unwrapExport,
} from "#test-utils/catalog-import.ts";
import { importRefusal } from "#test-utils/catalog-import-refusal.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { featureSetting } from "#test-utils/settings.ts";
import { placed } from "#test-utils/sql-text.ts";

/** Import a listing that asks for a built site and assert the import refuses
 * it with the translated refusal that names the listing. */
const expectPlanImportRefused = async (name: string): Promise<void> => {
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
  expect(importRefusal(result)).toBe(
    t("catalog_transfer.site_plan_listing_refused", { name }),
  );
};

/** A listing with a webhook and the defaults switch, exported by an editor and
 * renamed so it imports as a new listing. The editor's export leaves out the
 * fields an editor cannot set. */
const editorExportCopy = async () => {
  const source = await createTestListing({
    name: "Editor Listing",
    useDefaults: true,
    webhookUrl: "https://example.com/hook",
  });
  const blob = unwrapExport(await exportListing(source.id, "editor"));
  blob.listing.name = "Editor Listing copy";
  return blob;
};

const importLogisticsListing = async (name: string): Promise<boolean> => {
  const result = await importCatalog({
    kind: "listing",
    listing: { maxAttendees: 1, name, usesLogistics: true },
    version: 1,
  });
  if (!result.ok) throw new Error(result.error);
  return (await getListingWithCount(requireEntityImport(result).id))!
    .usesLogistics;
};

/** A file for a one-place listing under the named parents. */
const childBlob = (name: string, parents: string[]) => ({
  kind: "listing",
  listing: { maxAttendees: 1, name },
  parents,
});

/** Store thirty rows straight through a table, named after the prefix, so the
 *  setup stays clear of the per-request query guard. */
const storeThirty = async (
  prefix: string,
  insert: (row: {
    name: string;
    slug: string;
    slugIndex: BlindIndex;
  }) => Promise<unknown>,
): Promise<string[]> => {
  const { hmacHash } = await import("#crypto/hashing.ts");
  const names = Array.from({ length: 30 }, (_, i) => `${prefix} ${i}`);
  for (const name of names) {
    const slug = name.toLowerCase().replace(/\s+/g, "-");
    await insert({ name, slug, slugIndex: await hmacHash(slug) });
  }
  return names;
};

const nothingStored = (): Promise<void> => Promise.resolve();

/** A listing inside a package group that hides its listing names. */
const hiddenPackageParent = async (): Promise<void> => {
  const pkg = await createTestGroup({ isPackage: true, name: "Hidden Pkg" });
  // createTestGroup can't set hide_package_listings, so set it directly and
  // refresh the cached group set the import reads.
  await execute(
    sql`UPDATE groups SET hide_package_listings = 1 WHERE id = ${pkg.id}`,
  );
  const { groups } = await import("#db/groups.ts");
  groups.invalidate();
  const parent = await createTestListing({ name: "Pkg Parent" });
  await assignListingsToGroup([parent.id], pkg.id);
};

/** Two stored listings that share one name. */
const twinParents = async (): Promise<void> => {
  const { hmacHash } = await import("#crypto/hashing.ts");
  for (const slug of ["twin-a", "twin-b"]) {
    await createListing({
      maxAttendees: 1,
      maxPrice: 0,
      name: "Twin Parent",
      slug,
      slugIndex: await hmacHash(slug),
    });
  }
};

const standardGroupMember = async (): Promise<void> => {
  const group = await createTestGroup({ name: "Std Group" });
  await createTestListing({
    groupId: group.id,
    listingType: "standard",
    name: "Std Member",
  });
};

const fixedAndFlexibleDays = async (): Promise<void> => {
  await createTestListing({ listingType: "standard", name: "Fixed Days" });
  await createTestListing({
    customisableDays: true,
    dayPrices: { 1: 100 },
    durationDays: 1,
    listingType: "standard",
    name: "Flexible Days",
  });
};

/** Each refused import: its name, the rows stored first, the file, and a part
 *  of the refusal message. Every file is version 1. */
const REFUSED_IMPORTS: readonly (readonly [
  name: string,
  arrange: () => Promise<unknown>,
  blob: Record<string, unknown>,
  fragment: string,
])[] = [
  [
    "rejects a zero-capacity listing",
    nothingStored,
    { kind: "listing", listing: { maxAttendees: 0, name: "Zero Cap" } },
    "listing.maxAttendees",
  ],
  [
    "rejects a day-price key that is not a day count",
    nothingStored,
    {
      kind: "listing",
      listing: {
        dayPrices: { weekday: 100 },
        maxAttendees: 1,
        name: "Bad Day",
      },
    },
    "day count",
  ],
  [
    "rejects a duplicate parent reference",
    () => createTestListing({ name: "Dup Parent" }),
    childBlob("Dup Child", ["Dup Parent", "Dup Parent"]),
    "referenced more than once",
  ],
  [
    "rejects a parent that is a hidden-package member",
    hiddenPackageParent,
    childBlob("Kid", ["Pkg Parent"]),
    "package hides listing names",
  ],
  [
    "rejects an ambiguous (duplicate-named) reference",
    twinParents,
    childBlob("Ambiguous Child", ["Twin Parent"]),
    "names must be unique to import",
  ],
  [
    "surfaces a listing-validation error (group type mismatch)",
    standardGroupMember,
    {
      groups: [{ group: "Std Group" }],
      kind: "listing",
      listing: { listingType: "daily", maxAttendees: 5, name: "Daily Joiner" },
    },
    "same type",
  ],
  [
    "rejects a group name already in use",
    () => createTestGroup({ name: "Taken Group" }),
    { group: { name: "Taken Group" }, kind: "group", members: [] },
    "already exists",
  ],
  [
    "rejects group members that disagree on customisable days",
    fixedAndFlexibleDays,
    {
      group: { name: "Mixed Days" },
      kind: "group",
      members: [{ listing: "Fixed Days" }, { listing: "Flexible Days" }],
    },
    "customisable days",
  ],
  [
    "rejects a package group with a non-packageable member",
    () =>
      createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        name: "Pay What You Want",
        unitPrice: 1000,
      }),
    {
      group: { isPackage: true, name: "Bad Package" },
      kind: "group",
      members: [{ listing: "Pay What You Want" }],
    },
    "Packages cannot contain",
  ],
];

describeWithEnv(
  "catalog-transfer review fixes",
  {
    db: true,
    env: { CAN_BUILD_SITES: undefined },
  },
  () => {
    for (const [name, arrange, blob, fragment] of REFUSED_IMPORTS) {
      test(name, async () => {
        await arrange();
        const result = await importCatalog({ ...blob, version: 1 });
        if (result.ok) throw new Error(`${name}: the import was accepted`);
        assertStringIncludes(result.error, fragment);
      });
    }

    test("strips webhook URL and use-defaults for an editor import", async () => {
      const imported = await importedListing(
        await editorExportCopy(),
        "editor",
      );
      expect([imported.webhookUrl, imported.useDefaults]).toEqual(["", false]);
    });

    test("keeps the webhook URL for a non-editor import", async () => {
      const imported = await importedListing(
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
      expect(imported.webhookUrl).toBe("https://example.com/hook");
    });

    test("refuses a built-site plan listing whatever the builder configuration", async () => {
      await expectPlanImportRefused("No Builder");
      using _builderOn = withEnv({ CAN_BUILD_SITES: "true" });
      await expectPlanImportRefused("Builder On");
    });

    test("clears uses-logistics when logistics is disabled", async () => {
      await expect(importLogisticsListing("Logi Off")).rejects.toThrow(
        "usesLogistics needs logistics turned on",
      );
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
        (r) => r.listingId === requireEntityImport(result).id,
      )!;
      // The override is dropped because the group isn't a package.
      expect(row.packagePrice).toBeNull();
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
      expect(row.packagePrice).toBeNull();
      expect(row.quantity).toBe(1);
    });

    test("imports a listing with many parents in one batched insert", async () => {
      // More parents than the per-request N+1 guard (25) and the transaction
      // round-trip cap (~30) would allow one query/insert each — proves the
      // batched nested-parent check and the set-wise edge insert.
      // Supply dayPrices so insert does not read them back per row, which
      // would trip the N+1 guard across this 30-row setup.
      const parentNames = await storeThirty("Parent", (row) =>
        createListing({
          ...row,
          dayPrices: {},
          maxAttendees: 1,
          maxPrice: 0,
        }),
      );
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
      const groupNames = await storeThirty("Group", (row) =>
        records.groups.insert(newGroupValues(row)),
      );
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
      // The editor blob drops the field outright; it does not carry a
      // nullish placeholder for it.
      const editorBlob = unwrapExport(
        await exportListing(listing.id, "editor"),
      );
      expect(Object.hasOwn(editorBlob.listing, "webhookUrl")).toBe(false);
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
      expect(placed(statements[0]!).args.length).toBe(40 * 3);
    });
  },
);
