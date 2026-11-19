import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute } from "#db/client.ts";
import { invalidateListingsCache } from "#db/listings/records.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { aroundRowCheck } from "#test-utils/db-helpers/row-check.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

/** Remove the listing row straight from the database. */
const deleteListing = async (id: number): Promise<void> => {
  await execute(sql`DELETE FROM listings WHERE id = ${id}`);
  invalidateListingsCache();
};

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
          maxAttendees: "50",
          maxQuantity: "1",
          name: "",
        },
      );
      await expectHtmlResponse(response, 400, "Listing name is required");
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
          maxAttendees: "50",
          maxQuantity: "1",
          name: "",
          thankYouUrl: "https://example.com",
        });
        // Should return 400 with error page (listing exists -> listingErrorPage returns htmlResponse)
        await expectHtmlResponse(response, 400, "Listing name is required");
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
          maxAttendees: "50",
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

        // The check that the row is there sees the listing. The listing goes
        // just after, so getListingWithCount returns null.
        const readStub = aroundRowCheck(
          tables.listings,
          listing1.id,
          async (check) => {
            const found = await check();
            await deleteListing(listing1.id);
            return found;
          },
        );

        try {
          // Send an update with empty name to trigger validation error
          const { response } = await adminFormPost(
            `/admin/listing/${listing1.id}/edit`,
            {
              maxAttendees: "50",
              maxQuantity: "1",
              name: "",
            },
          );
          // requireExists sees the row (first check). Validation fails (empty name).
          // listingErrorPage calls getListingWithCount, but listing was deleted, so returns 404.
          expect(response.status).toBe(404);
        } finally {
          readStub.restore();
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

        // handleAdminListingEditPost calls getListingWithCount, then
        // updateResource.update which checks whether the row is still there.
        // The listing goes between the two.
        const readStub2 = aroundRowCheck(
          tables.listings,
          listing.id,
          async (check) => {
            await deleteListing(listing.id);
            return check();
          },
        );

        try {
          const { response } = await adminFormPost(
            `/admin/listing/${listing.id}/edit`,
            {
              maxAttendees: "50",
              maxQuantity: "1",
              name: "Updated Name",
              slug: "updated-slug",
            },
          );
          expect(response.status).toBe(404);
        } finally {
          readStub2.restore();
        }
      });
    });
  },
);
