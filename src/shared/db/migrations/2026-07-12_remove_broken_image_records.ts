import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { executeBatch } from "#db/client.ts";
import { bareSchemaMigration } from "./define.ts";

/**
 * Delete image records that never pointed at a real file.
 *
 * Until April 2026 (#914), saving a listing with no image stored its empty
 * image_url ENCRYPTED — a real ciphertext whose plaintext is "". Those values
 * decrypted back to "" on read, so every page treated them as "no image" and
 * they sat harmless for months. The first-class images migration
 * (2026-07-05_first_class_images) then gated its backfill on the SQL check
 * `image_url <> ''` — a comparison against the CIPHERTEXT, which is non-empty
 * for an encrypted "" — so each of those no-image listings got an `images` row
 * whose filename (and, via the thumbnail CASE, filename_thumb) decrypts to
 * nothing. There is no stored file behind such a record, so deleting it (and
 * its item links) is the whole repair; pages fall back to "no image" exactly
 * as they did before the backfill.
 *
 * Finding the rows requires decrypting every filename — a sanctioned one-off
 * scan-decrypt: the images table is a small operator-curated library, and the
 * ciphertext length alone cannot prove a plaintext is "". A filename that will
 * not decrypt at all is a different, unknown corruption: the migration throws
 * on it (and rolls nothing back — deletes only run after the scan) rather
 * than guessing that deleting data is safe.
 */
export default bareSchemaMigration(
  "2026-07-12_remove_broken_image_records",
  "Delete image records whose stored filename is an encrypted empty string, plus their item links.",
  async ({ getDb }) => {
    // Scanned in id order, so an aborted run's behaviour is deterministic:
    // everything before the record that failed was identified, nothing after.
    const result = await getDb().execute(
      "SELECT id, filename FROM images ORDER BY id",
    );
    const brokenIds: number[] = [];
    for (const row of result.rows) {
      const filename = await decrypt(row.filename as EnvKeyEncrypted);
      if (filename === "") brokenIds.push(Number(row.id));
    }
    if (brokenIds.length === 0) return;

    const placeholders = brokenIds.map(() => "?").join(", ");
    await executeBatch([
      {
        args: brokenIds,
        sql: `DELETE FROM image_uses WHERE image_id IN (${placeholders})`,
      },
      {
        args: brokenIds,
        sql: `DELETE FROM images WHERE id IN (${placeholders})`,
      },
    ]);
  },
);
