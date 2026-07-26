// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import { assertAdminHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { TEST_STORAGE_ZONE } from "#test-utils/internal.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > hidden listings", { db: true }, () => {
  describe("hidden listings", () => {
    test("creates listing with hidden enabled", async () => {
      const listing = await createTestListing({ hidden: true });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.hidden).toBe(true);
    });

    test("creates listing with hidden disabled by default", async () => {
      const listing = await createTestListing();
      const saved = await getListingWithCount(listing.id);
      expect(saved?.hidden).toBe(false);
    });

    test("updates listing to enable hidden", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, { hidden: true });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.hidden).toBe(true);
    });

    test("updates listing to enable can_pay_more via updateTestListing", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      await updateTestListing(listing.id, { canPayMore: true });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.can_pay_more).toBe(true);
    });

    test("updates listing to disable hidden", async () => {
      const listing = await createTestListing({ hidden: true });
      await updateTestListing(listing.id, { hidden: false });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.hidden).toBe(false);
    });

    test("admin listing detail page shows Hidden row when enabled", async () => {
      const { listing } = await setupListingAndLogin({
        hidden: true,
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Hidden",
        "not shown in public listings list",
      );
    });

    test("admin listing detail page does not show Hidden row when disabled", async () => {
      const { listing } = await setupListingAndLogin();
      const html = await assertAdminHtml(`/admin/listing/${listing.id}`);
      expect(html).not.toContain("not shown in public listings list");
    });

    test("admin listing edit page pre-fills hidden checkbox", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        hidden: true,
      });
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/edit`,
        {
          cookie,
        },
      );
      const html = await response.text();
      expect(html).toContain("hidden");
    });

    test("admin listing edit page shows attachment info when listing has attachment", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      await listingsTable.update(listing.id, {
        attachmentName: "Listing Guide.pdf",
        attachmentUrl: "uuid-guide.pdf",
      });

      await runWithStorageConfig(TEST_STORAGE_ZONE, async () => {
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/edit`,
          { cookie },
        );
        const html = await response.text();
        expect(html).toContain("attachment-info");
        expect(html).toContain("Listing Guide.pdf");
        expect(html).toContain("Remove Attachment");
      });
    });

    test("admin listing edit page does not show attachment info when empty", async () => {
      const { listing, cookie } = await setupListingAndLogin();

      await runWithStorageConfig(TEST_STORAGE_ZONE, async () => {
        const response = await awaitTestRequest(
          `/admin/listing/${listing.id}/edit`,
          { cookie },
        );
        const html = await response.text();
        expect(html).not.toContain("attachment-info");
        expect(html).not.toContain("Remove Attachment");
      });
    });
  });
});
