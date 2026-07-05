import { schemaMigration } from "./define.ts";

/**
 * Add `image_thumb_url` to listings, holding the 480px WebP thumbnail produced
 * alongside the full-size image on upload. Default '' ⇒ existing listings have
 * no thumbnail and fall back to their full image until re-uploaded.
 *
 * This historically added a listings column, since dropped. First-class image
 * records now store the thumbnail filename in images.filename_thumb; see
 * 2026-07-05_first_class_images.
 */
export default schemaMigration(
  "2026-07-03_listing_image_thumb",
  "Add image_thumb_url column to listings for the WebP thumbnail variant. (Historically added a column, since dropped; thumbnails now live on first-class images.)",
  {},
);
