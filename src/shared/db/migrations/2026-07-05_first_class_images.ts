import { schemaMigration } from "./define.ts";

/**
 * Promote uploaded images to first-class `images` records and link them through
 * `image_uses`. Existing listing rows are rebuilt from the current schema so
 * image filenames no longer live on listing records.
 */
export default schemaMigration(
  "2026-07-05_first_class_images",
  "Create first-class images and image_uses tables.",
  {
    indexes: ["idx_image_uses_item_order", "idx_image_uses_unique"],
    newTables: ["images", "image_uses"],
  },
  async ({ recreateTable }) => {
    await recreateTable("listings");
  },
);
