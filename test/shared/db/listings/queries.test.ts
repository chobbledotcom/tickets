import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeeNamesByIds } from "#shared/db/attendees/queries.ts";
import {
  getListingWithAttendeeRaw,
  getListingWithAttendeesRaw,
} from "#shared/db/listings/attendees.ts";
import {
  getAllListingOptions,
  getListingNamesByIds,
  getListingsBySlugsBatch,
  getListingWithCount,
  getStoredListingWithCount,
} from "#shared/db/listings/records.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { settings } from "#shared/db/settings.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  describe("batch queries", () => {
    test("getListingWithAttendeesRaw returns listing with attendees", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@example.com",
      );

      const result = await getListingWithAttendeesRaw(listing.id);
      expect(result).not.toBeNull();
      expect(result?.listing.id).toBe(listing.id);
      expect(result?.listing.attendee_count).toBe(1);
      expect(result?.attendeesRaw.length).toBe(1);
    });

    test("getListingWithAttendeesRaw returns null for non-existent listing", async () => {
      const result = await getListingWithAttendeesRaw(999);
      expect(result).toBeNull();
    });

    test("getListingWithAttendeeRaw returns listing with count fallback", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob",
        "bob@example.com",
      );

      const result = await getListingWithAttendeeRaw(listing.id, attendee.id);
      expect(result).not.toBeNull();
      expect(result?.listing.id).toBe(listing.id);
      expect(result?.attendeeRaw).not.toBeNull();
      expect(result?.listing.attendee_count).toBe(1);
    });

    test("getListingWithAttendeeRaw returns null for non-existent listing", async () => {
      const result = await getListingWithAttendeeRaw(999, 1);
      expect(result).toBeNull();
    });

    // Regression: these loaders SELECT the listing row directly (not via
    // LISTING_COUNT_SELECT), and income is now projected from the ledger rather
    // than read off a `listings.income` column. Dropping that column without
    // adding the projection to these queries left `income` undefined, so
    // decryptListingWithCount's Number(undefined) produced NaN. Both must report
    // the real ledger income.
    test("getListingWithAttendeesRaw projects ledger income (never NaN)", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      await postListingSale({
        attendeeId: attendee.id,
        gross: 2500,
        listingId: listing.id,
      });

      const result = await getListingWithAttendeesRaw(listing.id);
      expect(Number.isNaN(result?.listing.income)).toBe(false);
      expect(result?.listing.income).toBe(2500);
    });

    test("getListingWithAttendeeRaw projects ledger income (never NaN)", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace",
        "grace@example.com",
      );
      await postListingSale({
        attendeeId: attendee.id,
        gross: 1800,
        listingId: listing.id,
      });

      const result = await getListingWithAttendeeRaw(listing.id, attendee.id);
      expect(Number.isNaN(result?.listing.income)).toBe(false);
      expect(result?.listing.income).toBe(1800);
    });

    test("getListingsBySlugsBatch returns empty array for empty slugs", async () => {
      const result = await getListingsBySlugsBatch([]);
      expect(result).toEqual([]);
    });

    test("getListingsBySlugsBatch returns listings in slug order", async () => {
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

      const results = await getListingsBySlugsBatch([
        listing2.slug,
        listing1.slug,
      ]);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe(listing2.id);
      expect(results[1]?.id).toBe(listing1.id);
    });

    test("getListingsBySlugsBatch returns null for missing slugs", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Exists",
        thankYouUrl: "https://example.com",
      });

      const results = await getListingsBySlugsBatch([listing.slug, "missing"]);
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

    test("getListingNamesByIds returns decrypted names only for the given ids", async () => {
      const alpha = await createTestListing({
        maxAttendees: 10,
        name: "Alpha",
      });
      const beta = await createTestListing({ maxAttendees: 10, name: "Beta" });

      const names = await getListingNamesByIds([alpha.id]);

      expect(names.get(alpha.id)).toBe("Alpha");
      expect(names.has(beta.id)).toBe(false);
    });

    test("getListingNamesByIds returns an empty map for no ids", async () => {
      const names = await getListingNamesByIds([]);
      expect(names.size).toBe(0);
    });

    test("getAttendeeNamesByIds decrypts the name for the given attendee id", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace Hopper",
        "grace@example.com",
      );

      const privateKey = await getTestPrivateKey();
      const names = await getAttendeeNamesByIds([attendee.id], privateKey);

      expect(names.get(attendee.id)).toBe("Grace Hopper");
    });

    test("getAttendeeNamesByIds returns an empty map for no ids", async () => {
      const privateKey = await getTestPrivateKey();
      const names = await getAttendeeNamesByIds([], privateKey);
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
  },
);
