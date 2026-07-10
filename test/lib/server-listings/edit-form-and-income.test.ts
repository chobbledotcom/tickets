// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getListingWithCount,
  invalidateListingsCache,
} from "#shared/db/listings.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  assertAdminHtml,
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > edit form and income", { db: true }, () => {
  describe("GET /admin/listing/:id/edit", () => {
    testRequiresAuth("/admin/listing/1/edit", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/edit");
      expect(response.status).toBe(404);
    });

    test("shows edit form when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1500,
      });

      await assertAdminHtml(
        "/admin/listing/1/edit",
        'action="/admin/listing/1/edit"',
        'value="Test Listing"',
        'value="100"',
        'value="15.00"',
        'value="https://example.com/thanks"',
        `value="${listing.slug}"`,
        "Slug",
      );
    });

    test("shows the income-correction form with its ledger warning", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const response = await adminGet("/admin/listing/1/edit");
      const html = await response.text();
      // The dedicated money-correction section, separate from the counts override.
      expect(html).toContain("Adjust income");
      expect(html).toContain('action="/admin/listing/1/income"');
      expect(html).toContain('name="income"');
      // The prominent warning that this edits the source-of-truth money ledger.
      expect(html).toContain("correcting entry to the money ledger");
    });
  });
  describe("POST /admin/listing/:id/income", () => {
    test("posts a writeoff correction that raises the projected income", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      // Seed £15 of gross income, then correct it up to £25 (major units).
      await postListingSale({
        attendeeId: 1,
        gross: 1500,
        listingId: listing.id,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "25.00" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Listing income adjusted",
      )(response);

      invalidateListingsCache();
      const updated = await getListingWithCount(listing.id);
      expect(updated?.income).toBe(2500);
    });

    test("posts a writeoff correction that lowers the projected income", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await postListingSale({
        attendeeId: 1,
        gross: 4000,
        listingId: listing.id,
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "10.00" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Listing income adjusted",
      )(response);

      invalidateListingsCache();
      const updated = await getListingWithCount(listing.id);
      expect(updated?.income).toBe(1000);
    });

    test("logs a neutral activity message without the raw figure", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Gala",
        thankYouUrl: "https://example.com",
      });
      await adminFormPost(`/admin/listing/${listing.id}/income`, {
        income: "12.34",
      });
      const log = await getAllActivityLog(10);
      const entry = log.find((e) => e.message.includes("income adjusted"));
      expect(entry?.message).toBe("Listing 'Gala' income adjusted");
      // The raw corrected figure is not logged verbatim.
      expect(entry?.message).not.toContain("12.34");
    });

    test("rejects a blank amount with an error flash", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Enter a valid amount",
        false,
      )(response);
    });

    test("rejects a non-numeric amount with an error flash", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/income`,
        { income: "abc" },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/edit`,
        "Enter a valid amount",
        false,
      )(response);
    });

    test("returns 404 for a non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/9999/income", {
        income: "10",
      });
      expect(response.status).toBe(404);
    });
  });
});
