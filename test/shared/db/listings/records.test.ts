import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllListingOptions,
  getListingsBySlugs,
  getListingWithCount,
  getStoredListingsWithCountsByIds,
  getStoredListingWithCount,
  listingNames,
  requireListingsWithCountsByIds,
  requireListingWithCount,
} from "#db/listings/records.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
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
  },
);
