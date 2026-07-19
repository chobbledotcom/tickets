import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  assertAdminHtml,
  assertJson,
  expectRejectsEmptyName,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest, createTestApiKeyToken } from "#test-utils/session.ts";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("PUT /api/admin/listings/:listingId", () => {
    test("updates listing name", async () => {
      const listing = await createTestListing({ name: "Original" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { name: "Updated Name" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.name).toBe("Updated Name");
          expect(body.listing.id).toBe(listing.id);
        },
      );
    });

    test("updates listing with partial fields", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Partial Update",
      });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { description: "Updated desc", max_attendees: 100 },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.name).toBe("Partial Update");
          expect(body.listing.max_attendees).toBe(100);
          expect(body.listing.description).toBe("Updated desc");
        },
      );
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await apiRequest("/api/admin/listings/99999", {
        body: { name: "Ghost" },
        method: "PUT",
      });

      expect(response.status).toBe(404);
    });

    test("returns 404 when the listing vanishes during update", async () => {
      const listing = await createTestListing({ name: "Vanishing listing" });
      await getDb().execute(
        `CREATE TRIGGER delete_listing_during_update
         AFTER UPDATE ON listings
         WHEN NEW.id = ${listing.id}
         BEGIN
           DELETE FROM listings WHERE id = NEW.id;
         END`,
      );

      const response = await apiRequest(`/api/admin/listings/${listing.id}`, {
        body: { name: "Gone" },
        method: "PUT",
      });

      expect(response.status).toBe(404);
    });

    test("returns 400 when name is empty string", async () => {
      const listing = await createTestListing({ name: "Will Empty" });
      await expectRejectsEmptyName(`/api/admin/listings/${listing.id}`);
    });

    test("returns 400 for a fractional duration", async () => {
      const listing = await createTestListing({ name: "Whole Days" });
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { duration_days: 2.5 },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("duration_days must be a safe integer");
        },
      );
    });

    test("returns 400 when a bookable day is not text", async () => {
      const listing = await createTestListing({ name: "Named Days" });
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { bookable_days: ["Monday", 2] },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("bookable_days must contain only text");
        },
      );
    });

    test("rejects duplicate slug", async () => {
      const listing1 = await createTestListing({ name: "Listing One" });
      const listing2 = await createTestListing({ name: "Listing Two" });

      // Use listing1's slug for listing2
      await assertJson(
        apiRequest(`/api/admin/listings/${listing2.id}`, {
          body: { slug: listing1.slug },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("Slug is already in use by another listing");
        },
      );
    });

    test("allows keeping the same slug", async () => {
      const listing = await createTestListing({ name: "Keep Slug" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { name: "Renamed", slug: listing.slug },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.name).toBe("Renamed");
        },
      );
    });

    test("links an update to the listing activity page", async () => {
      const listing = await createTestListing({ name: "Activity before" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { name: "Activity after" },
          method: "PUT",
        }),
        200,
      );

      await assertAdminHtml(
        `/admin/listing/${listing.id}/activity`,
        "Listing 'Activity after' updated",
      );
    });
  });

  describe("PUT /api/admin/listings/:listingId - comprehensive field updates", () => {
    test("updates all fields on an listing", async () => {
      const listing = await createTestListing({ name: "Full Update" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: {
            active: true,
            bookable_days: ["Monday", "Wednesday", "Friday"],
            can_pay_more: true,
            closes_at: "2026-12-24T23:59:00Z",
            date: "2026-12-25T18:00:00Z",
            description: "New desc",
            fields: "email,phone,address",
            group_ids: [],
            hidden: true,
            listing_type: "daily",
            location: "New Location",
            max_attendees: 200,
            max_price: 5000,
            max_quantity: 10,
            maximum_days_after: 30,
            minimum_days_before: 3,
            name: "Fully Updated",
            non_transferable: true,
            thank_you_url: "https://new.example.com/thanks",
            unit_price: 1000,
            webhook_url: "https://new.example.com/hook",
          },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.name).toBe("Fully Updated");
          expect(body.listing.max_attendees).toBe(200);
          expect(body.listing.location).toBe("New Location");
          expect(body.listing.unit_price).toBe(1000);
          expect(body.listing.max_quantity).toBe(10);
          expect(body.listing.listing_type).toBe("daily");
          expect(body.listing.bookable_days).toEqual([
            "Monday",
            "Wednesday",
            "Friday",
          ]);
          expect(body.listing.minimum_days_before).toBe(3);
          expect(body.listing.maximum_days_after).toBe(30);
          expect(body.listing.non_transferable).toBe(true);
          expect(body.listing.can_pay_more).toBe(true);
          expect(body.listing.hidden).toBe(true);
        },
      );
    });

    test("updates customisable_days and day_prices", async () => {
      const listing = await createTestListing({
        durationDays: 2,
        name: "To Flex",
      });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: {
            customisable_days: true,
            day_prices: { 1: 500, 2: 900 },
            duration_days: 2,
          },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.customisable_days).toBe(true);
          expect(body.listing.day_prices).toEqual({ 1: 500, 2: 900 });
        },
      );
    });

    test("a PUT that omits day_prices leaves the existing day_count rows intact", async () => {
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 400, 2: 700 },
        durationDays: 3,
        name: "Keep Days",
      });

      // A partial update touching only the name must not wipe the day prices —
      // the JSON API defaults day_prices to the existing value and re-writes it.
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { name: "Kept Days" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.name).toBe("Kept Days");
          expect(body.listing.day_prices).toEqual({ 1: 400, 2: 700 });
        },
      );
    });

    test("clears date by setting it to null", async () => {
      const listing = await createTestListing({ name: "Clear Date" });
      const apiKey = await createTestApiKeyToken();

      // First set a date
      await apiRequest(`/api/admin/listings/${listing.id}`, {
        apiKey,
        body: { date: "2026-06-15T10:00:00Z" },
        method: "PUT",
      });

      // Then clear it
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          apiKey,
          body: { date: null },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.date).toBe("");
        },
      );
    });

    test("clears closes_at by setting it to null", async () => {
      const listing = await createTestListing({ name: "Clear Closes" });
      const apiKey = await createTestApiKeyToken();

      // First set closes_at
      await apiRequest(`/api/admin/listings/${listing.id}`, {
        apiKey,
        body: { closes_at: "2026-06-14T23:59:00Z" },
        method: "PUT",
      });

      // Then clear it
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          apiKey,
          body: { closes_at: null },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.closes_at).toBeNull();
        },
      );
    });

    test("returns 400 for max_attendees less than 1", async () => {
      const listing = await createTestListing({ name: "Bad Max" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { max_attendees: 0 },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("max_attendees must be >= 1");
        },
      );
    });

    test("validates can_pay_more max_price on update", async () => {
      const listing = await createTestListing({ name: "Pay More Update" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: {
            can_pay_more: true,
            max_price: 500,
            unit_price: 500,
          },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Maximum price");
        },
      );
    });
  });

  describe("PUT /api/admin/listings/:listingId - validation errors", () => {
    test("rejects update with invalid group", async () => {
      const listing = await createTestListing({ name: "Update Group" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { group_ids: [99999] },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("Selected group does not exist");
        },
      );
    });

    test("rejects update with mismatched group listing type", async () => {
      const group = await createTestGroup({ name: "Update Type Group" });

      // Create a standard listing in the group
      await apiRequest("/api/admin/listings", {
        body: {
          group_ids: [group.id],
          listing_type: "standard",
          max_attendees: 10,
          name: "Standard First",
        },
        method: "POST",
      });

      // Create a separate listing and try to add it as daily to same group
      const listing = await createTestListing({ name: "Move To Group" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { group_ids: [group.id], listing_type: "daily" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toContain("same type");
        },
      );
    });
  });
});
