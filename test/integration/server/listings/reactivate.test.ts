// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { testConfirmIdentifierMismatch } from "#test/lib/server-listings/confirm-identifier-mismatch.ts";
import {
  assertAdminHtml,
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > reactivate", { db: true }, () => {
  describe("GET /admin/listing/:id/reactivate", () => {
    testRequiresAuth("/admin/listing/1/reactivate", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("shows reactivate confirmation page when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the listing first
      await deactivateTestListing(listing.id);

      await assertAdminHtml(
        "/admin/listing/1/reactivate",
        "Reactivate Listing",
        "available for registrations",
        'name="confirm_identifier"',
        "type its name",
      );
    });
  });
  describe("POST /admin/listing/:id/reactivate", () => {
    test("reactivates listing and redirects", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the listing first
      await deactivateTestListing(listing.id);

      const { response } = await adminFormPost("/admin/listing/1/reactivate", {
        confirm_identifier: listing.name,
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing reactivated",
      )(response);

      // Verify listing is now active
      const activeListing = await getListingWithCount(1);
      expect(activeListing?.active).toBe(true);
    });

    testConfirmIdentifierMismatch(
      "/admin/listing/1/reactivate",
      "returns error when name does not match",
      "Listing name does not match",
      (listingId) => deactivateTestListing(listingId),
    );
  });
  describe("POST /admin/listing/:id/reactivate (listing not found)", () => {
    test("returns 404 when listing does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/reactivate",
        {
          confirm_identifier: "something",
        },
      );
      expect(response.status).toBe(404);
    });
  });
});
