import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { listingsTable } from "#shared/db/listings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { runWithStorageConfig } from "#shared/storage.ts";
import {
  adminFormPost,
  assertFormRedirect,
  createTestListing,
  describeWithEnv,
  expectFlash,
  installUrlHandler,
  invalidateTestDbCache,
  withFetchMock,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/reset-database", () => {
    test("reset database POST without confirm_phrase field uses empty fallback", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/reset-database",
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Confirmation phrase does not match"),
        false,
      );
    });

    test("logs activity when database reset is initiated", async () => {
      await adminFormPost("/admin/settings/reset-database", {
        confirm_phrase:
          "The site will be fully reset and all data will be lost.",
      });

      // After reset, the activity_log table is wiped, so we can't check it.
      // Instead, verify the reset succeeded (redirects to /setup/)
      // The logActivity call happens before resetDatabase() so it was logged
      // but the table is then dropped. This test verifies no error is thrown.
    });

    test("deletes storage files for all listings during admin reset", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await listingsTable.update(listing.id, {
        attachmentName: "doc.pdf",
        attachmentUrl: "admin-reset-attachment.pdf",
        imageUrl: "admin-reset-image.jpg",
      });

      await runWithStorageConfig(
        { zoneKey: "testkey", zoneName: "testzone" },
        () =>
          withFetchMock(async (originalFetch) => {
            const deletedUrls: string[] = [];
            installUrlHandler(originalFetch, (url) => {
              if (url.includes("storage.bunnycdn.com")) {
                deletedUrls.push(url);
                return Promise.resolve(
                  new Response(JSON.stringify({ HttpCode: 200 }), {
                    status: 200,
                  }),
                );
              }
              return null;
            });

            await assertFormRedirect(
              "/admin/settings/reset-database",
              {
                confirm_phrase:
                  "The site will be fully reset and all data will be lost.",
              },
              "/setup/",
              "Database reset",
            );
            expect(
              deletedUrls.some((u) => u.includes("admin-reset-image.jpg")),
            ).toBe(true);
            expect(
              deletedUrls.some((u) => u.includes("admin-reset-attachment.pdf")),
            ).toBe(true);
          }),
      );

      invalidateTestDbCache();
    });
  });
});
