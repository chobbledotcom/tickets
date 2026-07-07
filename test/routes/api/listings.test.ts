import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestAttendeeDirect,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  PublicListingSchema,
} from "#test-utils";

import {
  describePublicApi,
  expectCorsHeaders,
  fetchAvailability,
  fetchListingBySlug,
  fetchListingsList,
  fetchPublicListing,
} from "./helpers.ts";

describePublicApi(() => {
  describe("GET /api/listings", () => {
    test("returns empty array when no listings exist", async () => {
      const { response, listings } = await fetchListingsList();
      expect(response.status).toBe(200);
      expect(listings).toEqual([]);
      expectCorsHeaders(response);
    });

    test("returns active non-hidden listings", async () => {
      const listing = await createTestListing({ name: "Public Listing" });
      const { response, listings } = await fetchListingsList();
      expect(response.status).toBe(200);
      expect(listings.length).toBe(1);
      expect(listings[0]!.name).toBe("Public Listing");
      expect(listings[0]!.slug).toBe(listing.slug);
    });

    test("filters hidden listings from listing", async () => {
      await createTestListing({ hidden: false, name: "Visible" });
      await createTestListing({ hidden: true, name: "Hidden" });
      const { listings } = await fetchListingsList();
      expect(listings.length).toBe(1);
      expect(listings[0]!.name).toBe("Visible");
    });

    test("does not expose internal fields", async () => {
      await createTestListing();
      const { listings } = await fetchListingsList();
      // The strict schema requires every public field with the right type and
      // rejects any internal one (id, max_attendees, hidden, …), so a leak —
      // or a missing/mistyped public field — fails the parse.
      expect(() => v.parse(PublicListingSchema, listings[0])).not.toThrow();
    });

    test("sets isSoldOut when listing is at capacity", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      const { listings } = await fetchListingsList();
      expect(listings[0]!.isSoldOut).toBe(true);
      expect(listings[0]!.maxPurchasable).toBe(0);
    });

    test("a daily listing full on one date is not sold out date-lessly", async () => {
      // #51: cumulative bookings span every date, so without a date the API
      // makes no capacity claim for a daily listing — the date-aware
      // availability endpoint answers for a specific date.
      const listing = await createDailyTestListing({
        maxAttendees: 1,
        maxQuantity: 4,
      });
      await bookAttendee(listing, {
        date: addDays(todayInTz("UTC"), 2),
        quantity: 1,
      });
      const { listings } = await fetchListingsList();
      expect(listings[0]!.isSoldOut).toBe(false);
      expect(listings[0]!.maxPurchasable).toBe(4);
    });

    test("sets isSoldOut when sibling listing has filled the group cap", async () => {
      const group = await createTestGroup({
        maxAttendees: 2,
        name: "shared-cap",
        slug: "shared-cap",
      });
      const filler = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Filler",
      });
      const sibling = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Sibling",
      });
      await createTestAttendeeDirect(filler.id, "A", "a@test.com");
      await createTestAttendeeDirect(filler.id, "B", "b@test.com");

      const { listings } = await fetchListingsList();
      const siblingListing = listings.find((e) => e.slug === sibling.slug)!;
      expect(siblingListing.isSoldOut).toBe(true);
      expect(siblingListing.maxPurchasable).toBe(0);
    });

    test("clamps maxPurchasable to remaining group capacity", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "tight-cap",
        slug: "tight-cap",
      });
      const filler = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 1,
        name: "Filler2",
      });
      const sibling = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        // Larger than expected group remaining (5 − 3 = 2) so the assertion
        // proves the group clamp, not the per-listing maxQuantity.
        maxQuantity: 10,
        name: "Sibling2",
      });
      await createTestAttendeeDirect(filler.id, "C", "c@test.com");
      await createTestAttendeeDirect(filler.id, "D", "d@test.com");
      await createTestAttendeeDirect(filler.id, "E", "e@test.com");

      const { listings } = await fetchListingsList();
      const siblingListing = listings.find((e) => e.slug === sibling.slug)!;
      expect(siblingListing.isSoldOut).toBe(false);
      expect(siblingListing.maxPurchasable).toBe(2);
    });
  });

  describe("GET /api/listings/:slug", () => {
    test("returns listing details by slug", async () => {
      const listing = await createTestListing({
        description: "Hello",
        name: "My Listing",
      });
      const { apiListing, response } = await fetchPublicListing(listing.slug);
      expect(apiListing.name).toBe("My Listing");
      expect(apiListing.description).toBe("Hello");
      expectCorsHeaders(response);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response, body } = await fetchListingBySlug("nonexistent");
      expect(response.status).toBe(404);
      expect(body.error).toBe("Listing not found");
    });

    test("exposes customisable days and day prices", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
      });
      const { body } = await fetchListingBySlug(listing.slug);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.customisableDays).toBe(true);
      expect(apiListing.dayPrices).toEqual({ 1: 1000, 2: 1800 });
    });

    test("omits day prices for a fixed-duration listing", async () => {
      const listing = await createTestListing({ name: "Fixed" });
      const { body } = await fetchListingBySlug(listing.slug);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.customisableDays).toBe(false);
      expect(apiListing.dayPrices).toBeUndefined();
    });

    test("returns 404 for inactive listing", async () => {
      const listing = await createTestListing();
      await deactivateTestListing(listing.id);
      const { response } = await fetchListingBySlug(listing.slug);
      expect(response.status).toBe(404);
    });

    test("allows hidden listings to be accessed by slug", async () => {
      const listing = await createTestListing({
        hidden: true,
        name: "Hidden Listing",
      });
      const { apiListing } = await fetchPublicListing(listing.slug);
      expect(apiListing.name).toBe("Hidden Listing");
    });

    test("includes availableDates for daily listings", async () => {
      const listing = await createDailyTestListing();
      const { response, body } = await fetchListingBySlug(listing.slug);
      expect(response.status).toBe(200);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.listingType).toBe("daily");
      expect(Array.isArray(apiListing.availableDates)).toBe(true);
    });

    test("does not include availableDates for standard listings", async () => {
      const listing = await createTestListing();
      const { body } = await fetchListingBySlug(listing.slug);
      const apiListing = v.parse(PublicListingSchema, body.listing);
      expect(apiListing.availableDates).toBeUndefined();
    });
  });

  describe("GET /api/listings/:slug/availability", () => {
    test("returns available true when spots exist", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(listing.slug);
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
      expectCorsHeaders(response);
    });

    test("returns available false when sold out", async () => {
      const listing = await createTestListing({ maxAttendees: 1 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      const { body } = await fetchAvailability(listing.slug);
      expect(body.available).toBe(false);
    });

    test("a daily listing answers per date, not by the cumulative aggregate", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 1 });
      const date = addDays(todayInTz("UTC"), 2);
      await bookAttendee(listing, { date, quantity: 1 });
      const full = await fetchAvailability(listing.slug, `date=${date}`);
      expect(full.body.available).toBe(false);
      const free = await fetchAvailability(
        listing.slug,
        `date=${addDays(date, 1)}`,
      );
      expect(free.body.available).toBe(true);
    });

    test("respects quantity parameter", async () => {
      const listing = await createTestListing({ maxAttendees: 2 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      // 1 spot left, requesting 2
      const { body } = await fetchAvailability(listing.slug, "quantity=2");
      expect(body.available).toBe(false);
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await fetchAvailability("nonexistent");
      expect(response.status).toBe(404);
    });

    test("preserves quantity 0 instead of defaulting to 1", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(
        listing.slug,
        "quantity=0",
      );
      expect(response.status).toBe(200);
      // quantity=0 should be treated as 0, not silently become 1
      expect(body.available).toBe(true);
    });

    test("handles invalid quantity gracefully", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { response, body } = await fetchAvailability(
        listing.slug,
        "quantity=abc",
      );
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
    });

    test("does not parse a malformed quantity prefix", async () => {
      const listing = await createTestListing({ maxAttendees: 2 });
      await createTestAttendeeDirect(listing.id, "Alice", "a@test.com");
      const { response, body } = await fetchAvailability(
        listing.slug,
        "quantity=2x",
      );
      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
    });
  });
});
