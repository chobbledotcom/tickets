import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";

const setCatalogGallery = (enabled: boolean) =>
  adminFormPost("/admin/settings/catalog-gallery", {
    catalog_gallery_enabled: String(enabled),
  });

// Auth and CSRF rejection are shared gate behavior, covered by the
// external-order and logout suites; these tests own only this toggle.
describeWithEnv(
  "server (admin settings: catalog-gallery)",
  { db: true },
  () => {
    test("toggles the gallery and persists the choice", async () => {
      const enabled = await setCatalogGallery(true);
      expectFlash(
        enabled.response,
        expect.stringContaining("Product gallery catalog enabled"),
      );
      expect(settings.catalogGalleryEnabled).toBe(true);

      const disabled = await setCatalogGallery(false);
      expectFlash(
        disabled.response,
        expect.stringContaining("Product gallery catalog disabled"),
      );
      expect(settings.catalogGalleryEnabled).toBe(false);
    });
  },
);
