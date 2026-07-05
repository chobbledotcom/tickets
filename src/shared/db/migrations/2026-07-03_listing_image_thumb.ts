import { schemaMigration } from "./define.ts";

/** Retained migration marker; thumbnails now live on first-class image records. */
export default schemaMigration(
  "2026-07-03_listing_image_thumb",
  "Retain the image thumbnail migration marker; thumbnails are first-class image metadata.",
  {},
);
