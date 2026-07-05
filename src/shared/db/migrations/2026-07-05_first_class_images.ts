import { schemaMigration } from "./define.ts";

/**
 * Promote uploaded listing images to first-class `images` records and link them
 * back through `image_uses`. The old listing columns stored encrypted filenames
 * directly on each listing. Because the new image filename/name columns use the
 * same encryption key, the migration can copy ciphertext across unchanged:
 * `images.name` starts as the listing's encrypted name, and filename fields
 * start as the legacy encrypted filenames. Empty alt text stays the encrypted
 * text-column empty string convention (`''`).
 *
 * The backfill is gated on `listings.image_url`, so fresh databases whose SCHEMA
 * never had the legacy columns simply create the new tables/indexes.
 */
export default schemaMigration(
  "2026-07-05_first_class_images",
  "Move listing image columns into first-class images and image_uses tables.",
  {
    indexes: ["idx_image_uses_item_order", "idx_image_uses_unique"],
    newTables: ["images", "image_uses"],
  },
  async ({ getDb, recreateTable }) => {
    const info = await getDb().execute("PRAGMA table_info(listings)");
    const hasLegacyImageUrl = info.rows.some((row) => row.name === "image_url");
    const hasLegacyImageThumbUrl = info.rows.some(
      (row) => row.name === "image_thumb_url",
    );
    if (!hasLegacyImageUrl) return;

    const legacyThumbColumn = hasLegacyImageThumbUrl
      ? "image_thumb_url"
      : "'' AS image_thumb_url";
    const rows = await getDb().execute(
      `SELECT id, name, image_url, ${legacyThumbColumn} FROM listings WHERE image_url <> ''`,
    );
    for (const row of rows.rows) {
      const insert = await getDb().execute({
        args: [
          String(row.name),
          String(row.image_url),
          String(row.image_thumb_url),
        ],
        sql: "INSERT INTO images (name, filename, filename_thumb, alt_text) VALUES (?, ?, ?, '')",
      });
      await getDb().execute({
        args: [Number(insert.lastInsertRowid), Number(row.id)],
        sql: "INSERT OR IGNORE INTO image_uses (image_id, item_type, item_id, sort_order) VALUES (?, 'listing', ?, 0)",
      });
    }

    await recreateTable("listings");
  },
);
