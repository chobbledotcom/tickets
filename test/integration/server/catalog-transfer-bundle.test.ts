import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getGroupPackagePrices } from "#db/groups.ts";
import { listingParents } from "#db/listing-parents.ts";
import { getGroupDayPrices } from "#db/listing-prices.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  loadCatalogNameIndex,
  matchName,
  normalizeEntityName,
} from "#db/name-registry.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import type { CatalogBundle } from "#routes/admin/catalog-transfer/schema.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The id of the one listing whose name the index resolves. */
const listingIdByName = async (name: string): Promise<number> => {
  const { listing } = await loadCatalogNameIndex();
  const match = matchName(listing, name);
  if (!match.ok) throw new Error(`no listing named ${name} (${match.reason})`);
  return match.id;
};

/** The id of the one group whose name the index resolves. */
const groupIdByName = async (name: string): Promise<number> => {
  const { group } = await loadCatalogNameIndex();
  const match = matchName(group, name);
  if (!match.ok) throw new Error(`no group named ${name} (${match.reason})`);
  return match.id;
};

/** The stored listing ids whose normalised name starts with `prefix`. */
const listingIdsByNamePrefix = async (prefix: string): Promise<number[]> =>
  [...(await loadCatalogNameIndex()).listing]
    .filter(([key]) => key.startsWith(normalizeEntityName(prefix)))
    .flatMap(([, ids]) => ids);

/** A bundle of `count` listings that all join the two groups the document
 * declares — the day-group shape the issue reports (56 listings, day groups). */
const dayGroupBundle = (count: number): CatalogBundle => ({
  groups: [
    { group: { name: "Day 1" }, members: [] },
    { group: { name: "Day 2" }, members: [] },
  ],
  kind: "bundle",
  listings: Array.from({ length: count }, (_, index) => ({
    groups: [{ group: "Day 1" }, { group: "Day 2" }],
    listing: {
      description: `Act ${index} of the festival.`,
      maxAttendees: 40,
      maxPrice: 0,
      name: `Act ${index}`,
      unitPrice: 1200 + index,
    },
    parents: [],
  })),
  version: 1,
});

describeWithEnv("catalog bundle import", { db: true }, () => {
  test("creates 56 listings and 2 groups in one import, without one round trip per listing", async () => {
    enableQueryLog();
    const result = await importCatalog(dayGroupBundle(56));
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toEqual({ groups: 2, kind: "bundle", listings: 56 });

    // The site holds what the document declared: every listing with both
    // memberships, and both groups.
    const firstId = await listingIdByName("Act 0");
    const lastId = await listingIdByName("Act 55");
    const day1Id = await groupIdByName("Day 1");
    const day2Id = await groupIdByName("Day 2");
    const membershipRows = await execute(
      `SELECT COUNT(*) AS n FROM group_listings
        WHERE listing_id IN (?, ?) AND group_id IN (?, ?)`,
      [firstId, lastId, day1Id, day2Id],
    );
    expect(membershipRows.rows[0]!.n).toBe(4);
    // One round trip per listing would be 56 alone. The batched import stays
    // inside the interactive-transaction guard and the request budget.
    const roundTrips = new Set(getQueryLog().map((q) => q.startedAtMs)).size;
    expect(roundTrips).toBeLessThan(30);
  });

  test("creates nothing when one item fails, and names the failing item", async () => {
    await createTestListing({ name: "Already Here" });
    const bundle = dayGroupBundle(2);
    bundle.listings[0]!.listing.name = "Already Here";

    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(result.error, "No records were created.");
    assertStringIncludes(
      result.error,
      '"Already Here": A listing or group named "Already Here" already exists',
    );
    // The valid item of the same document is not imported either.
    expect(await listingIdsByNamePrefix("act ")).toEqual([]);
  });

  test("names a bundle item's parse failure by its own name and field", async () => {
    const bundle = dayGroupBundle(2);
    bundle.listings[1]!.listing.maxAttendees = 0;
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      '"Act 1": listing.maxAttendees: Invalid value: Expected >=1 but received 0',
    );
    // The document holds nothing back for the valid sibling either.
    expect(await listingIdsByNamePrefix("act ")).toEqual([]);
  });

  test("resolves relationships inside the document: membership, package overrides, parent edge", async () => {
    const bundle: CatalogBundle = {
      groups: [
        {
          group: {
            hidePackageListings: false,
            isPackage: true,
            name: "Weekend",
          },
          members: [
            { listing: "Workshop", packagePrice: 900, quantity: 2 },
            { dayPrices: { "1": 300 }, listing: "Social" },
          ],
        },
      ],
      kind: "bundle",
      listings: [
        {
          groups: [{ group: "Weekend", packagePrice: 900, quantity: 2 }],
          listing: {
            customisableDays: true,
            dayPrices: { "1": 1000, "2": 1800 },
            durationDays: 2,
            listingType: "standard",
            maxAttendees: 20,
            maxPrice: 0,
            maxQuantity: 2,
            name: "Workshop",
            unitPrice: 1500,
          },
          parents: [],
        },
        {
          groups: [],
          listing: {
            customisableDays: true,
            dayPrices: { "1": 600 },
            durationDays: 1,
            maxAttendees: 80,
            maxPrice: 0,
            name: "Social",
            unitPrice: 800,
          },
          parents: [],
        },
        {
          // A third item the package does not hold: it joins "Workshop" as an
          // add-on, exercising the document-internal parent edge.
          groups: [],
          listing: {
            maxAttendees: 10,
            maxPrice: 0,
            name: "Guide",
            unitPrice: 200,
          },
          parents: ["Workshop"],
        },
      ],
      version: 1,
    };
    const result = await importCatalog(bundle);
    if (!result.ok) throw new Error(result.error);

    const weekendId = await groupIdByName("Weekend");
    const workshopId = await listingIdByName("Workshop");
    const socialId = await listingIdByName("Social");
    const guideId = await listingIdByName("Guide");

    // The package carries both members with their overrides.
    const packageRows = await getGroupPackagePrices(weekendId);
    expect(packageRows).toHaveLength(2);
    expect(
      packageRows.find((row) => row.listing_id === workshopId),
    ).toMatchObject({ package_price: 900, quantity: 2 });
    // The Social member carries its per-day override.
    const dayPrices = await getGroupDayPrices(weekendId);
    expect(dayPrices.get(socialId)).toEqual(new Map([[1, 300]]));
    // The bundle-declared parent edge landed.
    expect(await listingParents.getIds(guideId)).toEqual([workshopId]);
  });

  test("refuses an add-on whose planned parent sits in a name-hiding package", async () => {
    const bundle = dayGroupBundle(1);
    bundle.groups = [
      {
        group: { hidePackageListings: true, isPackage: true, name: "Hidden" },
        members: [{ listing: "Act 0" }],
      },
    ];
    bundle.listings[0]!.groups = [{ group: "Hidden" }];
    bundle.listings.push({
      groups: [],
      listing: {
        maxAttendees: 5,
        maxPrice: 0,
        name: "Add-on",
        unitPrice: 100,
      },
      parents: ["Act 0"],
    });
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      '"Add-on": This listing cannot offer add-ons while its package hides listing names.',
    );
  });

  test("refuses an empty bundle", async () => {
    const result = await importCatalog({
      groups: [],
      kind: "bundle",
      listings: [],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      "The bundle holds no listings and no groups",
    );
  });

  test("rejects a duplicate name inside the document", async () => {
    const bundle = dayGroupBundle(2);
    bundle.listings[1]!.listing.name = "Act 0";
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      '"Act 0": A bundle can\'t hold two items named "Act 0"',
    );
  });

  test("reports a bundle item's field errors by item name", async () => {
    const bundle = dayGroupBundle(1);
    bundle.listings[0]!.listing.durationDays = 99;
    const result = await importCatalog(bundle);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    assertStringIncludes(
      result.error,
      '"Act 0": listing.durationDays: must be at most',
    );
  });

  test("clears the webhook URL for an editor bundle import", async () => {
    const bundle = dayGroupBundle(1);
    bundle.listings[0]!.listing.webhookUrl = "https://example.com/hook";
    const result = await importCatalog(bundle, "editor");
    if (!result.ok) throw new Error(result.error);
    const imported = await getListingWithCount(await listingIdByName("Act 0"));
    expect(imported!.webhook_url).toBe("");
  });
});
