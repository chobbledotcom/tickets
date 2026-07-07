import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import {
  getAllListings,
  getListing,
  getListingWithCount,
  isSlugTaken,
  listingsTable,
} from "#shared/db/listings.ts";
import {
  createTestAttendee,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  describe("CRUD", () => {
    test("createListing creates listing with correct properties", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "My Test Listing",
        thankYouUrl: "https://example.com/thanks",
      });

      expect(listing.id).toBe(1);
      expect(listing.name).toBe("My Test Listing");
      expect(listing.slug).toBeDefined();
      expect(listing.max_attendees).toBe(100);
      expect(listing.thank_you_url).toBe("https://example.com/thanks");
      expect(listing.created).toBeDefined();
      expect(listing.unit_price).toBe(0);
    });

    test("createListing creates listing with unit_price", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      expect(listing.unit_price).toBe(1000);
    });

    test("createListing stores and retrieves description", async () => {
      const listing = await createTestListing({
        description: "A test description",
        maxAttendees: 50,
      });

      expect(listing.description).toBe("A test description");
    });

    test("createListing defaults description to empty string", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
      });

      expect(listing.description).toBe("");
    });

    test("getAllListings returns empty array when no listings", async () => {
      const listings = await getAllListings();
      expect(listings).toEqual([]);
    });

    test("getAllListings returns listings with attendee count", async () => {
      await createTestListing({
        maxAttendees: 50,
        name: "Listing One",
        thankYouUrl: "https://example.com",
      });
      await createTestListing({
        maxAttendees: 100,
        name: "Listing Two",
        thankYouUrl: "https://example.com",
      });

      const listings = await getAllListings();
      expect(listings.length).toBe(2);
      expect(listings[0]?.attendee_count).toBe(0);
      expect(listings[1]?.attendee_count).toBe(0);
    });

    test("getListing returns null for missing listing", async () => {
      const listing = await getListing(999);
      expect(listing).toBeNull();
    });

    test("getListing returns listing by id", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        name: "Fetch Test",
        thankYouUrl: "https://example.com",
      });
      const fetched = await getListing(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("Fetch Test");
    });

    test("getListingWithCount returns null for missing listing", async () => {
      const listing = await getListingWithCount(999);
      expect(listing).toBeNull();
    });

    test("getListingWithCount returns listing with count", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const fetched = await getListingWithCount(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.attendee_count).toBe(0);
    });

    test("getListingWithCount reflects added attendees", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "a@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob",
        "b@example.com",
      );

      const fetched = await getListingWithCount(listing.id);
      expect(fetched?.attendee_count).toBe(2);
    });

    test("getAllListings reflects added attendees per listing", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });

      await createTestAttendee(
        listing1.id,
        listing1.slug,
        "A",
        "a@example.com",
      );
      await createTestAttendee(
        listing1.id,
        listing1.slug,
        "B",
        "b@example.com",
      );
      await createTestAttendee(
        listing2.id,
        listing2.slug,
        "C",
        "c@example.com",
      );

      const listings = await getAllListings();
      const byId = new Map(listings.map((e) => [e.id, e.attendee_count]));
      expect(byId.get(listing1.id)).toBe(2);
      expect(byId.get(listing2.id)).toBe(1);
    });

    test("listingsTable.update updates listing properties", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        name: "Original Listing",
        thankYouUrl: "https://example.com/original",
      });

      const updated = await listingsTable.update(created.id, {
        maxAttendees: 100,
        name: "Updated Listing",
        slug: created.slug,
        slugIndex: created.slug_index,
        thankYouUrl: "https://example.com/updated",
        unitPrice: 1500,
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Updated Listing");
      expect(updated?.max_attendees).toBe(100);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(1500);
    });

    test("listingsTable.update returns null for non-existent listing", async () => {
      const result = await listingsTable.update(999, {
        maxAttendees: 50,
        name: "Non Existent",
        slug: "non-existent",
        // Hand-crafted fixture stand-in for the blind index — test cast.
        slugIndex: "non-existent" as BlindIndex,
        thankYouUrl: "https://example.com",
      });
      expect(result).toBeNull();
    });

    test("listingsTable.update can set unit_price to zero", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const updated = await listingsTable.update(created.id, {
        maxAttendees: 50,
        name: created.name,
        slug: created.slug,
        slugIndex: created.slug_index,
        thankYouUrl: "https://example.com",
        unitPrice: 0,
      });

      expect(updated?.unit_price).toBe(0);
    });
  });

  describe("slug", () => {
    test("isSlugTaken with excludeListingId excludes that listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Slug Taken Test",
        thankYouUrl: "https://example.com",
      });

      const taken = await isSlugTaken(listing.slug);
      expect(taken).toBe(true);

      const notTaken = await isSlugTaken(listing.slug, listing.id);
      expect(notTaken).toBe(false);
    });
  });
});
