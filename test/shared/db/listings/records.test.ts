import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { execute, queryOne } from "#db/client.ts";
import { getListingDayPrices, PRICE_TYPE_BASE } from "#db/listing-prices.ts";
import {
  getAllListingOptions,
  getAllListings,
  getListingsBySlugs,
  getListingWithCount,
  getStoredListingsWithCountsByIds,
  getStoredListingWithCount,
  listingNames,
  listingsTable,
  requireListingsWithCountsByIds,
  requireListingWithCount,
} from "#db/listings/records.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { settings } from "#db/settings.ts";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv("db > listings > records", { db: true, triggers: true }, () => {
  describe("batch queries", () => {
    test("getListingsBySlugs returns empty array for empty slugs", async () => {
      const result = await getListingsBySlugs([]);
      expect(result).toEqual([]);
    });

    test("getStoredListingsWithCountsByIds asks the database nothing for no ids", async () => {
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        expect(await getStoredListingsWithCountsByIds([])).toEqual([]);
        expect(getQueryLog()).toEqual([]);
      });
    });

    test("getListingsBySlugs returns listings in slug order", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "Batch A",
        thankYouUrl: "https://example.com",
      });
      const listing2 = await createTestListing({
        maxAttendees: 20,
        name: "Batch B",
        thankYouUrl: "https://example.com",
      });

      const results = await getListingsBySlugs([listing2.slug, listing1.slug]);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe(listing2.id);
      expect(results[1]?.id).toBe(listing1.id);
    });

    test("getListingsBySlugs returns null for missing slugs", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Exists",
        thankYouUrl: "https://example.com",
      });

      const results = await getListingsBySlugs([listing.slug, "missing"]);
      expect(results.length).toBe(2);
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBeNull();
    });
  });

  describe("bounded name lookups", () => {
    test("getAllListingOptions returns every listing's decrypted name and active flag through the narrow projection", async () => {
      const alpha = await createTestListing({
        maxAttendees: 10,
        name: "Alpha",
      });
      const beta = await createTestListing({ maxAttendees: 10, name: "Beta" });
      await deactivateTestListing(beta.id);

      await runWithQueryLogContext(async () => {
        enableQueryLog();
        const options = await getAllListingOptions();

        expect(options).toEqual([
          { active: true, id: alpha.id, name: "Alpha" },
          { active: false, id: beta.id, name: "Beta" },
        ]);
        expect(getQueryLog().map((entry) => entry.sql)).toEqual([
          "SELECT listing.id, listing.name, listing.active FROM listings AS listing ORDER BY listing.id ASC",
        ]);
      });
    });

    test("getAllListingOptions returns an empty list with no listings", async () => {
      expect(await getAllListingOptions()).toEqual([]);
    });

    test("listingNames.byIds returns decrypted names only for the given ids", async () => {
      const alpha = await createTestListing({
        maxAttendees: 10,
        name: "Alpha",
      });
      const beta = await createTestListing({ maxAttendees: 10, name: "Beta" });

      const names = await listingNames.byIds([alpha.id]);

      expect(names.get(alpha.id)).toBe("Alpha");
      expect(names.has(beta.id)).toBe(false);
    });

    test("listingNames.byIds returns an empty map for no ids", async () => {
      const names = await listingNames.byIds([]);
      expect(names.size).toBe(0);
    });
  });
});

describeWithEnv(
  "db > listings > getStoredListingWithCount",
  { db: true, triggers: true },
  () => {
    test("returns the listing's own stored values, not inherited defaults", async () => {
      // Set the default first; creating the listing then invalidates the
      // listings cache, so the resolving read sees the default live.
      await settings.update.listingDefaults({ hidden: true });
      const listing = await createTestListing({
        hidden: false,
        useDefaults: true,
      });
      // The resolving read overlays the default…
      expect((await getListingWithCount(listing.id))?.hidden).toBe(true);
      // …the stored read preserves the listing's own column, so an edit save
      // built from it can't bake the default into the row.
      expect((await getStoredListingWithCount(listing.id))?.hidden).toBe(false);
    });

    test("returns null for a missing listing", async () => {
      expect(await getStoredListingWithCount(99999)).toBeNull();
    });

    test("required listing lookup names a missing listing", async () => {
      await expect(requireListingWithCount(99999)).rejects.toThrow(
        "Listing not found: 99999",
      );
    });

    test("required listing batch names the first missing listing", async () => {
      await expect(
        requireListingsWithCountsByIds([99998, 99999]),
      ).rejects.toThrow("Listing not found: 99998");
    });

    test("required listing lookup returns the listing it names", async () => {
      const listing = await createTestListing({ name: "Present And Counted" });
      expect((await requireListingWithCount(listing.id)).name).toBe(
        "Present And Counted",
      );
    });
  },
);

describeWithEnv(
  "db > listings > price and image writes",
  {
    db: true,
    triggers: true,
  },
  () => {
    const insertPriced = async () =>
      await listingsTable.insert({
        dayPrices: { 2: 500 },
        maxAttendees: 10,
        maxPrice: 0,
        name: "Price Sync",
        slug: "price-sync",
        slugIndex: await hmacHash("price-sync"),
        unitPrice: 700,
      });

    test("an insert stores day prices, mirrors the base price, and carries no image", async () => {
      const listing = await insertPriced();
      expect(listing.image_url).toBe("");
      expect(listing.image_thumb_url).toBe("");
      expect(listing.image_alt_text).toBe("");
      expect((await getListingDayPrices(listing.id))[2]).toBe(500);
      const base = await queryOne<{ unit_price: number }>(
        "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = ?",
        [listing.id, PRICE_TYPE_BASE],
      );
      expect(base?.unit_price).toBe(700);
    });

    test("an update rewrites the day prices and re-mirrors the base price", async () => {
      const listing = await insertPriced();
      await listingsTable.update(listing.id, {
        dayPrices: { 3: 900 },
        unitPrice: 800,
      });
      const prices = await getListingDayPrices(listing.id);
      expect(prices[2]).toBeUndefined();
      expect(prices[3]).toBe(900);
      const base = await queryOne<{ unit_price: number }>(
        "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = ?",
        [listing.id, PRICE_TYPE_BASE],
      );
      expect(base?.unit_price).toBe(800);
    });

    test("a booked listing's profit is its income minus its cost", async () => {
      const listing = await createTestListing({ unitPrice: 600 });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Profit Probe",
        "profit@example.com",
      );
      const counted = await requireListingWithCount(listing.id);
      expect(counted.cost).toBe(0);
      expect(counted.profit).toBe(counted.income);
      expect(Number.isFinite(counted.profit)).toBe(true);
    });
  },
);

describeWithEnv(
  "db > listings > cache wiring",
  { db: true, triggers: true },
  () => {
    test("a warm read asks nothing, and dependency writes empty the cache", async () => {
      await createTestListing({ name: "Cache Warmth" });
      await getAllListings();
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        await getAllListings();
        expect(getQueryLog()).toEqual([]);
      });

      // Each dependency table's writes must empty the cache again: the next
      // read re-queries. A no-op write still counts — invalidation keys on the
      // statement's table and (for attendees) its written columns.
      const writes: [string, string][] = [
        [
          "listing_attendees",
          "UPDATE listing_attendees SET quantity = quantity WHERE id = -1",
        ],
        ["transfers", "UPDATE transfers SET id = id WHERE id = -1"],
        [
          "listing_prices",
          "UPDATE listing_prices SET unit_price = unit_price WHERE listing_id = -1",
        ],
        [
          "image_uses",
          "UPDATE image_uses SET image_id = image_id WHERE image_id = -1",
        ],
        ["images", "UPDATE images SET id = id WHERE id = -1"],
      ];
      for (const [table, sql] of writes) {
        await execute(sql);
        const calls = await runWithQueryLogContext(async () => {
          enableQueryLog();
          await getAllListings();
          return getQueryLog().length;
        });
        expect(
          calls,
          `a write to ${table} must empty the listings cache`,
        ).toBeGreaterThan(0);
      }
    });

    test("cache stats identify the listings cache by name", async () => {
      expect(getAllCacheStats().map((stat) => stat.name)).toContain("listings");
    });
  },
);
