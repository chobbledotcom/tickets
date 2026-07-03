import { schemaMigration } from "./define.ts";

/**
 * Add `image_thumb_url` to listings, holding the 480px WebP thumbnail produced
 * alongside the full-size image on upload. Default '' ⇒ existing listings have
 * no thumbnail and fall back to their full image until re-uploaded; the column
 * rides the wide `SELECT listing.*` caches and backup/restore automatically.
 */
export default schemaMigration(
  "2026-07-03_listing_image_thumb",
  "Add image_thumb_url column to listings for the WebP thumbnail variant.",
  {
    columns: { listings: ["image_thumb_url"] },
  },
);
