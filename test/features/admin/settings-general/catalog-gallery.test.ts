import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { expectFlash, expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminFormPost, testCookie } from "#test-utils/session.ts";

// Auth and CSRF rejection are shared gate behavior, covered by the
// external-order and logout suites; these tests own only this toggle.
describeWithEnv(
  "server (admin settings: catalog-gallery)",
  { db: true },
  () => {
    test("enables the product gallery catalog", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/catalog-gallery",
        { catalog_gallery_enabled: "true" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Product gallery catalog enabled"),
      );
    });

    test("disables the product gallery catalog", async () => {
      await adminFormPost("/admin/settings/catalog-gallery", {
        catalog_gallery_enabled: "true",
      });
      const { response } = await adminFormPost(
        "/admin/settings/catalog-gallery",
        { catalog_gallery_enabled: "false" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Product gallery catalog disabled"),
      );
    });

    test("setting persists in the database", async () => {
      expect(settings.catalogGalleryEnabled).toBe(false);

      await adminFormPost("/admin/settings/catalog-gallery", {
        catalog_gallery_enabled: "true",
      });

      expect(settings.catalogGalleryEnabled).toBe(true);
    });

    test("advanced settings page shows the catalog-gallery toggle", async () => {
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Show the listings page as a product gallery?",
        "catalog_gallery_enabled",
      );
    });
  },
);
