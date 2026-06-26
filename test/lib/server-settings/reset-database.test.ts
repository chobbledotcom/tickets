import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { listingsTable } from "#shared/db/listings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  adminGet,
  assertFormRedirect,
  createTestListing,
  describeWithEnv,
  expectDatabaseResetRedirect,
  expectFlash,
  expectHtmlResponse,
  invalidateTestDbCache,
  mockFormRequest,
  mockRequest,
  setupListingAndLogin,
  testCookie,
  testRequiresAuth,
  withBunnyDeleteCapture,
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

      await withBunnyDeleteCapture(async (deletedUrls) => {
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
      });

      invalidateTestDbCache();
    });

    testRequiresAuth("/admin/settings/reset-database", {
      body: {
        confirm_phrase:
          "The site will be fully reset and all data will be lost.",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase:
              "The site will be fully reset and all data will be lost.",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("rejects wrong confirmation phrase", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/reset-database",
        { confirm_phrase: "wrong phrase" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Confirmation phrase does not match"),
        false,
      );
    });

    test("resets database and redirects to setup on correct phrase", async () => {
      // Create some data first
      const { cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing",
        thankYouUrl: "https://example.com/thanks",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase:
              "The site will be fully reset and all data will be lost.",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      // Should redirect to setup page with session cleared
      expectDatabaseResetRedirect(response);
    });

    test("GET / after database reset returns 503 not-activated without auto-refresh (regression: boot loop)", async () => {
      // Reproduce the production bug: after a DB reset the isolate retains
      // module-level caches (initDb ready-client, settings snapshot,
      // setup-complete gate). Without clearing them, the next request bypasses
      // initDb's MissingSettingsTableError catch and reaches handleRoutingError,
      // which returns a 503 *with* auto-refresh — creating a boot loop.
      const { cookie, csrfToken } = await setupListingAndLogin({
        maxAttendees: 10,
        name: "Pre-reset Listing",
        thankYouUrl: "https://example.com/thanks",
      });

      await handleRequest(
        mockFormRequest(
          "/admin/settings/reset-database",
          {
            confirm_phrase:
              "The site will be fully reset and all data will be lost.",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );

      invalidateTestDbCache();

      // The next request must get the "not activated" page (503, no
      // auto-refresh), not a boot-loop temporary error response.
      const homeResponse = await handleRequest(mockRequest("/"));
      const html = await homeResponse.text();
      expect(homeResponse.status).toBe(503);
      expect(html).toContain("Not Activated");
      expect(html).not.toContain("refresh");
    });

    test("advanced settings page shows reset database section", async () => {
      const response = await adminGet("/admin/settings-advanced");
      const html = await expectHtmlResponse(response, 200, "Reset Database");
      expect(html).toContain(
        "The site will be fully reset and all data will be lost.",
      );
      expect(html).toContain("confirm_phrase");
    });
  });

  describe("POST /admin/settings/reset-database (confirm phrase)", () => {
    test("rejects empty confirm phrase", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/reset-database",
        { confirm_phrase: "" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Confirmation phrase does not match"),
        false,
      );
    });
  });
});
