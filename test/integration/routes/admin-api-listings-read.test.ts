import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { bookingPageHtml } from "#test-utils/parents.ts";
import {
  apiRequest,
  createTestApiKeyToken,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

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

  describe("listing child IDs", () => {
    test("rejects child_listing_ids when it is not an array", async () => {
      const listing = await createTestListing({ name: "Array required" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { child_listing_ids: "1" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "child_listing_ids must be an array of listing ids",
          );
        },
      );
    });

    test("accepts listing ID 1 as a positive integer", async () => {
      const listing = await createTestListing({ name: "Positive IDs" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { child_listing_ids: [1] },
          method: "PUT",
        }),
        200,
      );
    });

    test("rejects a fractional child listing ID", async () => {
      const listing = await createTestListing({ name: "Integer IDs" });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { child_listing_ids: [1.5] },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "child_listing_ids must contain only positive integer listing ids",
          );
        },
      );
    });

    test("creates a parent with the first listing as its child", async () => {
      const child = await createTestListing({ name: "First child" });
      let parentSlug = "";

      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            child_listing_ids: [child.id],
            max_attendees: 10,
            name: "New parent",
          },
          method: "POST",
        }),
        201,
        (body) => {
          parentSlug = body.listing.slug;
        },
      );

      expect(await bookingPageHtml(parentSlug)).toContain("First child");
    });
  });
});
