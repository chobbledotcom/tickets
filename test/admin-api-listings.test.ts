import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { bodyToCreateInput, bodyToUpdateInput } from "#routes/admin/api.ts";
import { queryAll } from "#shared/db/client.ts";
import {
  getListingWithCount,
  invalidateListingsCache,
  listingsTable,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  apiRequest,
  assertJson,
  createTestApiKeyToken,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectRejectsEmptyName,
  mockRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
  testListingWithCount,
} from "#test-utils";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("GET /api/admin/listings/:listingId", () => {
    test("returns single listing by ID", async () => {
      const listing = await createTestListing({ name: "Detail Listing" });
      const apiKey = await createTestApiKeyToken();

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, { apiKey }),
        200,
        (body) => {
          expect(body.listing.name).toBe("Detail Listing");
          expect(body.listing.id).toBe(listing.id);
          expect(body.listing.slug_index).toBeUndefined();
        },
      );
    });

    test("returns 404 for non-existent listing", async () => {
      await assertJson(apiRequest("/api/admin/listings/99999"), 404, (body) => {
        expect(body.error).toBe("Listing not found");
      });
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(
        mockRequest("/api/admin/listings/1"),
      );

      expect(response.status).toBe(401);
    });

    test("works with cookie+CSRF auth", async () => {
      const listing = await createTestListing({ name: "Cookie Detail" });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await assertJson(
        handleRequest(
          requestAsSession(`/api/admin/listings/${listing.id}`, {
            cookie,
            csrfToken,
          }),
        ),
        200,
        (body) => {
          expect(body.listing.name).toBe("Cookie Detail");
        },
      );
    });
  });

  describe("POST /api/admin/listings", () => {
    test("creates listing with required fields", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            max_attendees: 50,
            name: "New API Listing",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.name).toBe("New API Listing");
          expect(body.listing.max_attendees).toBe(50);
          expect(body.listing.id).toBeGreaterThan(0);
          expect(body.listing.slug_index).toBeUndefined();
        },
      );
    });

    test("persists duration_days for daily listings", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: 3,
            listing_type: "daily",
            max_attendees: 20,
            name: "Multi-day Workshop",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.duration_days).toBe(3);
          expect(body.listing.listing_type).toBe("daily");
        },
      );
    });

    test("defaults duration_days to 1 when omitted", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            listing_type: "daily",
            max_attendees: 20,
            name: "Single-day Workshop",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.duration_days).toBe(1);
        },
      );
    });

    test("creates listing with all optional fields", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            bookable_days: ["Monday", "Tuesday"],
            can_pay_more: true,
            description: "A test listing",
            fields: "email,phone",
            hidden: false,
            listing_type: "standard",
            location: "Test Hall",
            max_attendees: 100,
            max_price: 1000,
            max_quantity: 5,
            maximum_days_after: 60,
            minimum_days_before: 2,
            name: "Full Listing",
            non_transferable: true,
            thank_you_url: "https://example.com/thanks",
            unit_price: 500,
            webhook_url: "https://example.com/webhook",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.name).toBe("Full Listing");
          expect(body.listing.description).toBe("A test listing");
          expect(body.listing.location).toBe("Test Hall");
          expect(body.listing.unit_price).toBe(500);
          expect(body.listing.max_quantity).toBe(5);
          expect(body.listing.max_price).toBe(1000);
          expect(body.listing.non_transferable).toBe(true);
          expect(body.listing.can_pay_more).toBe(true);
          expect(body.listing.hidden).toBe(false);
        },
      );
    });

    test("rejects an unsafe (internal) webhook_url (SSRF guard)", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            max_attendees: 10,
            name: "SSRF Attempt",
            webhook_url: "http://169.254.169.254/latest/meta-data",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Webhook URL");
        },
      );
    });

    test("creates a customisable-days listing with day_prices", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            customisable_days: true,
            // Mixed entries: day<1, non-integer key, and a non-numeric value
            // are all dropped by the parser.
            day_prices: { 0: 50, 1: 1000, 2: 1800, 3: "nope", x: 70 },
            duration_days: 3,
            max_attendees: 20,
            name: "Flexible Pass",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.customisable_days).toBe(true);
          expect(body.listing.day_prices).toEqual({ 1: 1000, 2: 1800 });
        },
      );
    });

    test("syncs listing_prices on the transactional API create path", async () => {
      // The API create goes through the crud-api sideEffect (child-edge) path,
      // which uses insertStatement and so bypasses the listingsTable wrapper;
      // the afterWrite hook must still reconcile listing_prices.
      const response = await apiRequest("/api/admin/listings", {
        body: {
          customisable_days: true,
          day_prices: { 1: 1000, 2: 1800 },
          duration_days: 2,
          max_attendees: 20,
          name: "API Priced",
          unit_price: 900,
        },
        method: "POST",
      });
      const { listing } = await response.json();
      const rows = await queryAll(
        `SELECT price_type, price_id, unit_price FROM listing_prices
          WHERE listing_id = ? ORDER BY price_type, price_id`,
        [listing.id],
      );
      expect(rows).toEqual([
        { price_id: "", price_type: "base", unit_price: 900 },
        { price_id: "1", price_type: "day_count", unit_price: 1000 },
        { price_id: "2", price_type: "day_count", unit_price: 1800 },
      ]);
    });

    test("returns 400 when name is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: { max_attendees: 50 },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });

    test("returns 400 when max_attendees is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: { name: "No Max" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("max_attendees is required and must be >= 1");
        },
      );
    });

    test("returns 400 when max_attendees is zero", async () => {
      const response = await apiRequest("/api/admin/listings", {
        body: { max_attendees: 0, name: "Zero Max" },
        method: "POST",
      });

      expect(response.status).toBe(400);
    });

    test("validates can_pay_more requires sufficient max_price", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            can_pay_more: true,
            max_attendees: 10,
            max_price: 500,
            name: "Pay More Listing",
            unit_price: 500,
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Maximum price");
        },
      );
    });

    test("validates group exists", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_id: 99999,
            max_attendees: 10,
            name: "Group Listing",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("Selected group does not exist");
        },
      );
    });
  });

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

    test("returns 400 when name is empty string", async () => {
      const listing = await createTestListing({ name: "Will Empty" });
      await expectRejectsEmptyName(`/api/admin/listings/${listing.id}`);
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
  });

  describe("DELETE /api/admin/listings/:listingId", () => {
    test("deletes listing with matching confirm_identifier", async () => {
      const listing = await createTestListing({ name: "Delete Me" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { confirm_identifier: "Delete Me" },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body.status).toBe("ok");
        },
      );

      // Verify listing is gone
      invalidateListingsCache();
      const deleted = await getListingWithCount(listing.id);
      expect(deleted).toBeNull();
    });

    test("rejects with wrong confirm_identifier", async () => {
      const listing = await createTestListing({ name: "Protect Me" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { confirm_identifier: "Wrong Name" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Listing name does not match");
        },
      );
    });

    test("rejects without confirm_identifier", async () => {
      const listing = await createTestListing({ name: "Need Confirm" });

      const response = await apiRequest(`/api/admin/listings/${listing.id}`, {
        body: {},
        method: "DELETE",
      });

      expect(response.status).toBe(400);
    });

    test("confirm_identifier is case-insensitive", async () => {
      const listing = await createTestListing({ name: "Case Test" });

      const response = await apiRequest(`/api/admin/listings/${listing.id}`, {
        body: { confirm_identifier: "case test" },
        method: "DELETE",
      });

      expect(response.status).toBe(200);
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await apiRequest("/api/admin/listings/99999", {
        body: { confirm_identifier: "Ghost" },
        method: "DELETE",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/admin/listings/:listingId/deactivate", () => {
    test("deactivates an active listing", async () => {
      const listing = await createTestListing({ name: "Active Listing" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}/deactivate`, {
          method: "POST",
        }),
        200,
        (body) => {
          expect(body.listing.active).toBe(false);
          expect(body.listing.name).toBe("Active Listing");
        },
      );
    });

    test("returns 400 when listing is already deactivated", async () => {
      const listing = await createTestListing({ name: "Inactive Listing" });
      const apiKey = await createTestApiKeyToken();

      // Deactivate first
      await apiRequest(`/api/admin/listings/${listing.id}/deactivate`, {
        apiKey,
        method: "POST",
      });

      // Try to deactivate again
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}/deactivate`, {
          apiKey,
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("Listing is already deactivated");
        },
      );
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await apiRequest(
        "/api/admin/listings/99999/deactivate",
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/admin/listings/:listingId/reactivate", () => {
    test("reactivates a deactivated listing", async () => {
      const listing = await createTestListing({ name: "Reactivate Listing" });
      const apiKey = await createTestApiKeyToken();

      // Deactivate first
      await apiRequest(`/api/admin/listings/${listing.id}/deactivate`, {
        apiKey,
        method: "POST",
      });

      // Now reactivate
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}/reactivate`, {
          apiKey,
          method: "POST",
        }),
        200,
        (body) => {
          expect(body.listing.active).toBe(true);
          expect(body.listing.name).toBe("Reactivate Listing");
        },
      );
    });

    test("returns 400 when listing is already active", async () => {
      const listing = await createTestListing({ name: "Already Active" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}/reactivate`, {
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("Listing is already active");
        },
      );
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await apiRequest(
        "/api/admin/listings/99999/reactivate",
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/admin/listings - date and closes_at handling", () => {
    test("creates listing with date and closes_at", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            active: true,
            closes_at: "2026-06-14T23:59:00Z",
            date: "2026-06-15T10:00:00Z",
            max_attendees: 20,
            name: "Dated Listing",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.date).toBe("2026-06-15T10:00:00.000Z");
          expect(body.listing.closes_at).toBe("2026-06-14T23:59:00.000Z");
          expect(body.listing.active).toBe(true);
        },
      );
    });

    test("creates listing with empty name string returns error", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: { max_attendees: 10, name: "   " },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
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
            group_id: 0,
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

  describe("DELETE /api/admin/listings/:listingId - with media", () => {
    test("deletes listing with image_url and attachment_url", async () => {
      const listing = await createTestListing({ name: "Media Listing" });
      // Set image_url and attachment_url directly
      await listingsTable.update(listing.id, {
        attachmentUrl: "https://cdn.example.com/file.pdf",
        imageUrl: "https://cdn.example.com/image.jpg",
      });
      invalidateListingsCache();

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { confirm_identifier: "Media Listing" },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body.status).toBe("ok");
        },
      );
    });
  });

  describe("bodyToCreateInput", () => {
    test("returns error for non-string name", async () => {
      const result = await bodyToCreateInput({ max_attendees: 10, name: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("name is required");
    });

    test("returns error for missing max_attendees", async () => {
      const result = await bodyToCreateInput({ name: "Test" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("max_attendees is required and must be >= 1");
      }
    });

    test("handles all field types correctly", async () => {
      const result = await bodyToCreateInput({
        active: false,
        bookable_days: ["Monday"],
        closes_at: "2026-06-14T23:59:00Z",
        date: "2026-06-15T10:00:00Z",
        max_attendees: 10,
        name: "Test",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.active).toBe(false);
        expect(result.input.bookableDays).toEqual(["Monday"]);
        expect(result.input.slug).toBeTruthy();
      }
    });

    test("maps the use_defaults flag both ways and omits it when absent", async () => {
      // true/false both round-trip (so the API can opt in *and* out), and an
      // absent flag stays absent rather than defaulting to either value.
      const cases: Array<[boolean | undefined, boolean | undefined]> = [
        [true, true],
        [false, false],
        [undefined, undefined],
      ];
      for (const [sent, expected] of cases) {
        const body: Record<string, unknown> = {
          max_attendees: 10,
          name: "Inheriting",
        };
        if (sent !== undefined) body.use_defaults = sent;
        const result = await bodyToCreateInput(body);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.input.useDefaults).toBe(expected);
      }
    });
  });

  describe("POST /api/admin/listings - group validation", () => {
    test("creates listing in a valid group", async () => {
      const group = await createTestGroup({ name: "Valid Group" });

      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_id: group.id,
            listing_type: "standard",
            max_attendees: 10,
            name: "Grouped Listing",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.group_id).toBe(group.id);
        },
      );
    });

    test("rejects listing with mismatched type in group", async () => {
      const group = await createTestGroup({ name: "Type Group" });

      // Create a standard listing in the group
      await apiRequest("/api/admin/listings", {
        body: {
          group_id: group.id,
          listing_type: "standard",
          max_attendees: 10,
          name: "Standard In Group",
        },
        method: "POST",
      });

      // Try to create a daily listing in the same group
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_id: group.id,
            listing_type: "daily",
            max_attendees: 10,
            name: "Daily In Group",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain("same type");
        },
      );
    });

    test("can_pay_more with valid max_price passes validation", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            can_pay_more: true,
            max_attendees: 10,
            max_price: 700,
            name: "Pay More Valid",
            unit_price: 500,
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.can_pay_more).toBe(true);
        },
      );
    });

    test("can_pay_more without unit_price passes validation", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            can_pay_more: true,
            max_attendees: 10,
            max_price: 200,
            name: "Free Pay More",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.can_pay_more).toBe(true);
        },
      );
    });
  });

  describe("PUT /api/admin/listings/:listingId - validation errors", () => {
    test("rejects update with invalid group", async () => {
      const listing = await createTestListing({ name: "Update Group" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { group_id: 99999 },
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
          group_id: group.id,
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
          body: { group_id: group.id, listing_type: "daily" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toContain("same type");
        },
      );
    });
  });

  describe("bodyToUpdateInput", () => {
    test("preserves existing values when fields not provided", async () => {
      const existing = testListingWithCount({
        bookable_days: ["Monday"],
        closes_at: "2026-01-02T00:00:00.000Z",
        date: "2026-01-01T00:00:00.000Z",
        description: "Existing desc",
        location: "Old Place",
        max_attendees: 50,
        max_quantity: 2,
        maximum_days_after: 90,
        minimum_days_before: 1,
        name: "Existing",
        slug: "existing-slug",
        thank_you_url: "https://old.com/thanks",
        unit_price: 100,
        webhook_url: "https://old.com/hook",
      });

      const result = await bodyToUpdateInput({}, existing);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.name).toBe("Existing");
        expect(result.input.description).toBe("Existing desc");
        expect(result.input.location).toBe("Old Place");
        expect(result.input.unitPrice).toBe(100);
        expect(result.input.maxQuantity).toBe(2);
        expect(result.input.thankYouUrl).toBe("https://old.com/thanks");
        expect(result.input.webhookUrl).toBe("https://old.com/hook");
        expect(result.input.active).toBe(true);
        expect(result.input.fields).toBe("email");
        expect(result.input.closesAt).toBe("2026-01-02T00:00:00.000Z");
        expect(result.input.listingType).toBe("standard");
        expect(result.input.bookableDays).toEqual(["Monday"]);
        expect(result.input.minimumDaysBefore).toBe(1);
        expect(result.input.maximumDaysAfter).toBe(90);
        expect(result.input.nonTransferable).toBe(false);
        expect(result.input.canPayMore).toBe(false);
        expect(result.input.hidden).toBe(false);
        expect(result.input.maxPrice).toBe(0);
      }
    });

    test("merges onto stored values, not inherited defaults", async () => {
      // Set the default first so creating the listing invalidates the cache and
      // the resolving lookup sees the default live.
      await settings.update.listingDefaults({ hidden: true });
      const listing = await createTestListing({
        hidden: false,
        useDefaults: true,
      });
      const resolved = (await getListingWithCount(listing.id))!;
      // The lookup row inherits the default…
      expect(resolved.hidden).toBe(true);
      // …but an update that doesn't touch hidden keeps the listing's stored
      // false, so clearing the default later still restores its own value.
      const result = await bodyToUpdateInput({ name: "Renamed" }, resolved);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.input.hidden).toBe(false);
    });

    test("preserves use_defaults when absent and toggles it when sent", async () => {
      const existing = testListingWithCount({
        max_attendees: 10,
        name: "Inheriting",
        slug: "inheriting",
        use_defaults: true,
      });
      // Omitted → the flag is preserved (an unrelated PUT can't un-inherit it).
      const kept = await bodyToUpdateInput({}, existing);
      expect(kept.ok && kept.input.useDefaults).toBe(true);
      // Explicit false → turned off.
      const off = await bodyToUpdateInput({ use_defaults: false }, existing);
      expect(off.ok && off.input.useDefaults).toBe(false);
    });

    test("preserves existing closes_at null as empty string", async () => {
      const existing = testListingWithCount({
        closes_at: null,
        max_attendees: 10,
        name: "No Closes",
        slug: "no-closes",
      });

      const result = await bodyToUpdateInput({}, existing);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.closesAt).toBe("");
      }
    });
  });

  describe("months_per_unit and initial_site_months", () => {
    test("months_per_unit round-trips on save", async () => {
      const listing = await createTestListing({
        hidden: true,
        monthsPerUnit: 3,
        purchaseOnly: true,
        unitPrice: 500,
      });
      const fetched = await getListingWithCount(listing.id);
      expect(fetched?.months_per_unit).toBe(3);
    });

    test("initial_site_months round-trips on save", async () => {
      const listing = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 6,
      });
      const fetched = await getListingWithCount(listing.id);
      expect(fetched?.initial_site_months).toBe(6);
    });

    test("months_per_unit > 0 with purchase_only=0 is rejected", async () => {
      await expect(
        createTestListing({
          monthsPerUnit: 1,
          purchaseOnly: false,
        }),
      ).rejects.toThrow();
    });
  });
});
