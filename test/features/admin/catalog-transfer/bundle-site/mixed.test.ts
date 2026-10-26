import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getGroupPackagePrices } from "#db/groups.ts";
import { listingParents } from "#db/listing-parents.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import type { CatalogBundle } from "#routes/admin/catalog-transfer/schema.ts";
import {
  requireBundleImport,
  storedGroupIdOf,
  storedListingIdOf,
} from "#test-utils/catalog-import.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createGroupWithListings,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A planned listing that joins a stored package and one that carries a
 * stored parent: the mixed document the site-reference paths serve. */
const mixedBundle = (): CatalogBundle => ({
  groups: [],
  kind: "bundle",
  listings: [
    {
      groups: [{ group: "Stored Pack", packagePrice: 700, quantity: 1 }],
      listing: {
        maxAttendees: 5,
        maxPrice: 0,
        name: "Joiner",
        unitPrice: 500,
      },
      parents: [],
    },
    {
      groups: [],
      listing: {
        maxAttendees: 5,
        maxPrice: 0,
        name: "Add-on",
        unitPrice: 100,
      },
      parents: ["Stored Parent"],
    },
  ],
  version: 1,
});

describeWithEnv("bundle references to stored rows", { db: true }, () => {
  test("writes memberships and parent edges against stored rows", async () => {
    await createTestListing({ name: "Stored Parent" });
    await createTestGroup({ isPackage: true, name: "Stored Pack" });
    const result = await importCatalog(mixedBundle());
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual({ groups: 0, kind: "bundle", listings: 2 });
    // The stored package now carries the planned member at its override.
    const packId = await storedGroupIdOf("Stored Pack");
    const joinerId = await storedListingIdOf("Joiner");
    const members = await getGroupPackagePrices(packId);
    expect(members.find((row) => row.listing_id === joinerId)).toMatchObject({
      package_price: 700,
    });
    // The stored parent edge landed.
    const addOnId = await storedListingIdOf("Add-on");
    const parentId = await storedListingIdOf("Stored Parent");
    expect(await listingParents.getIds(addOnId)).toEqual([parentId]);
  });

  test("refuses one link declared twice with different settings", async () => {
    const bundle = mixedBundle();
    // The same link, declared by the listing side and by the group side with
    // different overrides.
    bundle.listings[0]!.groups = [
      { group: "Two Sides", packagePrice: 700, quantity: 1 },
    ];
    bundle.groups = [
      {
        group: { isPackage: true, name: "Two Sides" },
        members: [{ listing: "Joiner", packagePrice: 800, quantity: 1 }],
      },
    ];
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, "linked twice, with different settings");
  });

  test("refuses a planned member whose pick count passes its own cap", async () => {
    await createTestGroup({ isPackage: true, name: "Stored Pack" });
    const bundle = mixedBundle();
    bundle.listings[0]!.groups = [
      { group: "Stored Pack", packagePrice: 700, quantity: 4 },
    ];
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, '"Joiner"');
  });

  test("joins a stored ordinary group without a package check", async () => {
    await createGroupWithListings("Plain Group", ["Stored Parent"]);
    const bundle = mixedBundle();
    bundle.listings[0]!.groups = [{ group: "Plain Group" }];
    const result = await importCatalog(bundle);
    expect(requireBundleImport(result).listings).toBe(2);
  });

  test("accepts an add-on whose stored parent sits in a visible package", async () => {
    await createGroupWithListings("Shown Pack", ["Stored Parent"]);
    const packId = await storedGroupIdOf("Shown Pack");
    await execute("UPDATE groups SET is_package = 1 WHERE id = ?", [packId]);
    const bundle = mixedBundle();
    bundle.listings[0]!.groups = [
      { group: "Shown Pack", packagePrice: 700, quantity: 1 },
    ];
    const result = await importCatalog(bundle);
    expect(requireBundleImport(result).listings).toBe(2);
  });

  test("merges a plain group's members with the ordinary default", async () => {
    const bundle: CatalogBundle = {
      groups: [
        {
          group: { name: "Plain Day" },
          members: [{ listing: "Ordinary Joiner" }],
        },
      ],
      kind: "bundle",
      listings: [
        {
          groups: [{ group: "Plain Day" }],
          listing: {
            maxAttendees: 5,
            maxPrice: 0,
            name: "Ordinary Joiner",
            unitPrice: 100,
          },
          parents: [],
        },
      ],
      version: 1,
    };
    const result = await importCatalog(bundle);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual({ groups: 1, kind: "bundle", listings: 1 });
  });

  test("refuses an add-on whose stored parent sits in a hiding package", async () => {
    await createGroupWithListings("Hiding Pack", ["Stored Parent"]);
    const packId = await storedGroupIdOf("Hiding Pack");
    await execute(
      "UPDATE groups SET is_package = 1, hide_package_listings = 1 WHERE id = ?",
      [packId],
    );
    const bundle = mixedBundle();
    bundle.listings[0]!.groups = [];
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      "cannot offer add-ons while its package hides listing names",
    );
  });
});
