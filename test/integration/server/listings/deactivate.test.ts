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
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > deactivate", { db: true }, () => {
  describe("GET /admin/listing/:id/deactivate", () => {
    testRequiresAuth("/admin/listing/1/deactivate", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/deactivate");
      expect(response.status).toBe(404);
    });

    test("shows deactivate confirmation page when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      await assertAdminHtml(
        "/admin/listing/1/deactivate",
        "Deactivate Listing",
        "Return a 404",
        'name="confirm_identifier"',
        "type its name",
        listing.name,
      );
    });
  });
  describe("POST /admin/listing/:id/deactivate", () => {
    testRequiresAuth("/admin/listing/1/deactivate", {
      body: {},
      method: "POST",
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("deactivates listing and redirects", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/deactivate", {
        confirm_identifier: listing.name,
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing deactivated",
      )(response);

      // Verify listing is now inactive
      const deactivatedListing = await getListingWithCount(1);
      expect(deactivatedListing?.active).toBe(false);
    });

    testConfirmIdentifierMismatch(
      "/admin/listing/1/deactivate",
      "returns error when identifier does not match",
      "Listing name does not match",
    );
  });
  describe("POST /admin/listing/:id/deactivate (listing not found)", () => {
    test("returns 404 when listing does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/listing/999/deactivate",
        {
          confirm_identifier: "something",
        },
      );
      expect(response.status).toBe(404);
    });
  });
});
