// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getDb } from "#shared/db/client.ts";
import { invalidateListingsCache, listingsTable } from "#shared/db/listings.ts";
import {
  adminFormPost,
  createTestAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  setupListingAndLogin,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server listings > error pages and fallbacks",
  { db: true },
  () => {
    /** Posts an edit with an empty name to a fresh listing and expects the
     *  validation error page — the shared behavior both the "edit validation
     *  error" and "listing error page" coverage below assert. */
    const expectEmptyNameEditError = async (name: string): Promise<void> => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name,
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          max_attendees: "50",
          max_quantity: "1",
          name: "",
        },
      );
      await expectHtmlResponse(response, 400, "Listing Name is required");
    };

    describe("admin/listings.ts (listingErrorPage with deleted listing)", () => {
      test("edit validation returns 400 with error when listing exists", async () => {
        await setupListingAndLogin({
          maxAttendees: 100,
          name: "First Edit Err",
          thankYouUrl: "https://example.com",
        });

        // Submit with empty name to trigger validation error
        const { response } = await adminFormPost("/admin/listing/1/edit", {
          max_attendees: "50",
          max_quantity: "1",
          name: "",
          thank_you_url: "https://example.com",
        });
        // Should return 400 with error page (listing exists -> listingErrorPage returns htmlResponse)
        await expectHtmlResponse(response, 400, "Listing Name is required");
      });
    });
    describe("admin/listings.ts (form.get fallbacks)", () => {
      test("deactivate listing without confirm_identifier uses empty fallback", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Deactivate Fallback",
          thankYouUrl: "https://example.com",
        });

        // Submit without confirm_identifier field
        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/deactivate`,
          {},
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Listing name does not match"),
          false,
        );
      });

      test("reactivate listing without confirm_identifier uses empty fallback", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 100,
          name: "Reactivate Fallback",
          thankYouUrl: "https://example.com",
        });
        await deactivateTestListing(listing.id);

        // Submit without confirm_identifier field
        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/reactivate`,
          {},
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Listing name does not match"),
          false,
        );
      });

      test("delete listing without confirm_identifier uses empty fallback", async () => {
        await setupListingAndLogin({
          maxAttendees: 100,
          name: "Delete Fallback",
          thankYouUrl: "https://example.com",
        });

        // Submit without confirm_identifier field
        const { response } = await adminFormPost("/admin/listing/1/delete", {});
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("does not match"), false);
      });
    });
    describe("POST /admin/listing/:id/edit validation error", () => {
      test("shows error when editing non-existent listing", async () => {
        const { response } = await adminFormPost("/admin/listing/99999/edit", {
          max_attendees: "50",
          name: "Updated Name",
        });
        expect(response.status).toBe(404);
      });

      test("shows edit page with error when name is empty", async () => {
        await expectEmptyNameEditError("Edit Orig");
      });
    });
    describe("routes/admin/listings.ts (listing error page)", () => {
      test("shows edit error page for existing listing with validation error", async () => {
        await expectEmptyNameEditError("Listing Err 1");
      });

      test("unlinks the listing's attendees when deleted with verification skipped", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          name: "Skip Verify Del Test",
        });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "Del User",
          "del@example.com",
        );

        const { response } = await adminFormPost(
          `/admin/listing/${listing.id}/delete?verify_identifier=false`,
          {},
        );
        await expectFlashRedirect("/admin", "Listing deleted")(response);

        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(0);
      });
    });
    describe("routes/admin/listings.ts (listingErrorPage notFound)", () => {
      test("listing edit validation error returns 404 when listing was deleted", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Listing For Delete Err",
        });

        // Spy on listingsTable.findById: return the row on first call (so requireExists passes),
        // but also delete the listing from DB so getListingWithCount (raw SQL) returns null.
        const originalFindById = listingsTable.findById.bind(listingsTable);
        const findByIdStub = stub(
          listingsTable,
          "findById",
          async (id: unknown) => {
            const row = await originalFindById(id as number);
            if (row) {
              // Delete the listing from DB so getListingWithCount returns null
              await getDb().execute({
                args: [id as number],
                sql: "DELETE FROM listings WHERE id = ?",
              });
              invalidateListingsCache();
            }
            return row;
          },
        );

        try {
          // Send an update with empty name to trigger validation error
          const { response } = await adminFormPost(
            `/admin/listing/${listing1.id}/edit`,
            {
              max_attendees: "50",
              max_quantity: "1",
              name: "",
            },
          );
          // requireExists sees the row (first findById). Validation fails (empty name).
          // listingErrorPage calls getListingWithCount, but listing was deleted, so returns 404.
          expect(response.status).toBe(404);
        } finally {
          findByIdStub.restore();
        }
      });
    });
    describe("edit listing notFound race condition", () => {
      test("returns 404 when listing is deleted during edit update", async () => {
        const { listing } = await setupListingAndLogin({
          maxAttendees: 50,
          name: "Race Condition Listing",
          thankYouUrl: "https://example.com",
        });

        // handleAdminListingEditPost calls getListingWithCount (raw SQL), then
        // updateResource.update which calls requireExists -> table.findById.
        // We spy on findById to return null, simulating the listing being deleted
        // between the initial check and the update.
        const findByIdStub2 = stub(listingsTable, "findById", () =>
          Promise.resolve(null),
        );

        try {
          const { response } = await adminFormPost(
            `/admin/listing/${listing.id}/edit`,
            {
              max_attendees: "50",
              max_quantity: "1",
              name: "Updated Name",
              slug: "updated-slug",
            },
          );
          expect(response.status).toBe(404);
        } finally {
          findByIdStub2.restore();
        }
      });
    });
  },
);
