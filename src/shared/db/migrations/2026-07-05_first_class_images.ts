import { executeBatch } from "#shared/db/client.ts";
import { schemaMigration } from "./define.ts";
import { getExistingColumns } from "./schema-sync.ts";

/**
 * Promote uploaded images to first-class `images` records and link them through
 * `image_uses`. Each listing's existing image is copied into an `images` row and
 * linked as that listing's first image BEFORE the listing rows are rebuilt from
 * the current schema — the rebuild drops the legacy `image_url`/`image_thumb_url`
 * columns, so a backfill after it would find nothing left to copy.
 *
 * The legacy columns and the new `images` columns share the same app-layer
 * encryption (same key; `''` means "no value"), so ciphertext copies across
 * verbatim. Each copied image takes its listing's id as its own id, which keeps
 * the copy a single deterministic statement and makes the crash-retry re-run
 * land on the same rows (`INSERT OR IGNORE`). The image inherits the listing's
 * (encrypted) name — the admin UI requires a name and falls back to it as alt
 * text — and an empty alt text, since the legacy system stored none. A listing
 * whose image predates thumbnails reuses its full-size file as the thumbnail,
 * exactly how it rendered before this migration; a database upgrading from
 * before the thumbnail column simply has no thumbnails to copy. The backfill is
 * gated on the legacy column still existing, so a re-run — or a fresh database
 * whose SCHEMA never had it — skips straight to the rebuild.
 */
export default schemaMigration(
  "2026-07-05_first_class_images",
  "Create first-class images and image_uses tables.",
  {
    indexes: ["idx_image_uses_item_order", "idx_image_uses_unique"],
    newTables: ["images", "image_uses"],
  },
  async ({ recreateTable }) => {
    const columns = await getExistingColumns("listings");
    if (columns.has("image_url")) {
      const thumbnail = columns.has("image_thumb_url")
        ? "CASE WHEN listing.image_thumb_url = '' THEN listing.image_url ELSE listing.image_thumb_url END"
        : "listing.image_url";
      await executeBatch([
        {
          args: [],
          sql: `INSERT OR IGNORE INTO images (id, name, filename, filename_thumb, alt_text)
                SELECT listing.id, listing.name, listing.image_url, ${thumbnail}, ''
                  FROM listings AS listing
                 WHERE listing.image_url <> ''`,
        },
        {
          args: [],
          sql: `INSERT OR IGNORE INTO image_uses (image_id, item_type, item_id, sort_order)
                SELECT listing.id, 'listing', listing.id, 0
                  FROM listings AS listing
                 WHERE listing.image_url <> ''`,
        },
      ]);
    }
    await recreateTable("listings");
  },
);
