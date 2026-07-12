import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getListingWithCount,
  invalidateListingsCache,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest, createTestApiKeyToken } from "#test-utils/session.ts";

describeWithEnv("Admin API - Listings", { db: true }, () => {
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

  describe("DELETE /api/admin/listings/:listingId - with media", () => {
    test("deletes listing with attachment_url", async () => {
      const listing = await createTestListing({ name: "Media Listing" });
      await listingsTable.update(listing.id, {
        attachmentUrl: "https://cdn.example.com/file.pdf",
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
});
