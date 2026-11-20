import { settings } from "#db/settings.ts";
import { describeBooleanSetting } from "#test-utils/setting-toggle.ts";

describeBooleanSetting({
  disabledFlash: "Product gallery catalog disabled",
  enabledFlash: "Product gallery catalog enabled",
  field: "catalog_gallery_enabled",
  isEnabled: () => settings.catalogGalleryEnabled,
  label: "the product gallery catalog",
  name: "catalog-gallery",
  path: "/admin/settings/catalog-gallery",
  question: "Show the listings page as a product gallery?",
});
