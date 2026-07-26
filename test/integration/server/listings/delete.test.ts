// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  assertAdminHtml,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  followRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > delete", { db: true }, () => {
  describe("GET /admin/listing/:id/delete", () => {
    testRequiresAuth("/admin/listing/1/delete", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/delete");
      expect(response.status).toBe(404);
    });

    test("shows delete confirmation page when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      await assertAdminHtml(
        "/admin/listing/1/delete",
        "Delete Listing",
        listing.name,
        "type its name",
      );
    });
  });
  describe("POST /admin/listing/:id/delete", () => {
    testRequiresAuth("/admin/listing/1/delete", {
      body: {
        confirm_identifier: "Test Listing",
      },
      method: "POST",
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          name: "Test Listing",
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/999/delete", {
        confirm_identifier: "Test Listing",
      });
      expect(response.status).toBe(404);
    });

    test("rejects invalid CSRF token", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/listing/1/delete",
          {
            confirm_identifier: listing.name,
            csrf_token: "invalid-token",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects mismatched listing identifier", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/delete", {
        confirm_identifier: "wrong-identifier",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("does not match"), false);
    });

    test("displays error on confirmation page after failed attempt", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { cookie, response: postResponse } = await adminFormPost(
        "/admin/listing/1/delete",
        { confirm_identifier: "wrong" },
      );
      const page = await followRedirectWithFlash(
        postResponse,
        handleRequest,
        cookie,
      );
      const html = await page.text();
      expect(html).toContain("does not match");
    });

    test("deletes listing with matching identifier (case insensitive)", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/delete", {
        confirm_identifier: "TEST LISTING", // uppercase (case insensitive)
      });
      await expectFlashRedirect("/admin", "Listing deleted")(response);

      // Verify listing was deleted
      const deletedListing = await getListingWithCount(1);
      expect(deletedListing).toBeNull();
    });

    test("deletes listing with matching identifier (trimmed)", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/delete", {
        confirm_identifier: "  Test Listing  ", // with spaces
      });
      await expectFlashRedirect("/admin", "Listing deleted")(response);
    });

    test("deletes the listing and unlinks its attendees", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane Doe",
        "jane@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete`,
        { confirm_identifier: listing.name },
      );
      expect(response.status).toBe(302);

      // The listing is gone and no attendees remain linked to it (the attendee
      // rows themselves are orphaned, not purged).
      const deleted = await getListingWithCount(listing.id);
      expect(deleted).toBeNull();

      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees).toEqual([]);
    });

    test("skips identifier verification when verify_identifier=false (for API users)", async () => {
      await createTestListing({
        maxAttendees: 50,
        name: "API Listing",
        thankYouUrl: "https://example.com",
      });

      // Delete with verify_identifier=false - no need for confirm_identifier
      const { response } = await adminFormPost(
        "/admin/listing/1/delete?verify_identifier=false",
      );
      expect(response.status).toBe(302);

      // Verify listing was deleted
      const listing = await getListingWithCount(1);
      expect(listing).toBeNull();
    });

    test("returns 404 when listing not found with verify_identifier=false", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/9999/delete?verify_identifier=false",
      );
      expect(response.status).toBe(404);
    });
  });
  describe("DELETE /admin/listing/:id/delete", () => {
    test("deletes listing using DELETE method", async () => {
      await createTestListing({
        maxAttendees: 50,
        name: "Delete Method Test",
        thankYouUrl: "https://example.com",
      });

      // Use DELETE method with verify_identifier=false
      const response = await handleRequest(
        new Request(
          "http://localhost/admin/listing/1/delete?verify_identifier=false",
          {
            body: new URLSearchParams({
              csrf_token: await testCsrfToken(),
            }).toString(),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: await testCookie(),
              host: "localhost",
            },
            method: "DELETE",
          },
        ),
      );
      expect(response.status).toBe(302);

      // Verify listing was deleted
      const listing = await getListingWithCount(1);
      expect(listing).toBeNull();
    });
  });
  describe("POST /admin/listing/:id/delete with custom onDelete", () => {
    test("deletes the listing when identifier verification is skipped", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Skip Verify Delete",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Test User",
        "test@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete?verify_identifier=false`,
        {},
      );
      await expectFlashRedirect("/admin", "Listing deleted")(response);

      const deleted = await getListingWithCount(listing.id);
      expect(deleted).toBeNull();
    });
  });
  describe("admin/listings.ts (listing delete handler via onDelete)", () => {
    test("delete listing handler cleans up associated data", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "On Delete Test",
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Test User",
        "test@example.com",
      );

      // Delete listing via API (skip verify)
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete?verify_identifier=false`,
        {},
      );
      expect(response.status).toBe(302);

      // Verify both listing and attendees deleted
      expect(await getListingWithCount(listing.id)).toBeNull();
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });
  });
  describe("admin listing onDelete handler", () => {
    test("deleting an listing triggers the onDelete handler which calls deleteListing", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 10,
        name: "Delete OnDelete Test",
      });
      // Add an attendee so delete covers more paths
      await createTestAttendee(
        listing.id,
        listing.slug,
        "User A",
        "a@test.com",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/delete`,
        { confirm_identifier: listing.name },
      );
      expect(response.status).toBe(302);
    });
  });
});
