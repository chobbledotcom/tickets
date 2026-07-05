import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createBackupZip, restoreFromZip } from "#shared/db/backup.ts";
import { getDb, queryAll, queryOne } from "#shared/db/client.ts";
import { initDb } from "#shared/db/migrations.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/**
 * Regression tests for restoring a backup taken before a column-dropping
 * migration. The restore rebuilds the database at the CURRENT schema and then
 * replays the dump, so an INSERT that still writes a since-dropped column
 * (e.g. listings.image_url, dropped by 2026-07-05_first_class_images) used to
 * fail with "table listings has no column named image_url" — aborting the
 * restore after the wipe. The dump's own schema_migrations rows record the
 * drop migration as pending, so restoring the column lets the next boot
 * replay it exactly as a live upgrade would.
 */
describeWithEnv("db > backup restore", { db: true, triggers: true }, () => {
  const listingColumnNames = async (): Promise<string[]> => {
    const rows = await queryAll<{ name: string }>(
      "SELECT name FROM pragma_table_info('listings')",
    );
    return rows.map((row) => row.name);
  };

  describe("backups taken before a column-dropping migration", () => {
    const FIRST_CLASS_IMAGES_ID = "2026-07-05_first_class_images";

    /** Reshape the test database into its pre-first-class-images form: the
     *  legacy encrypted image columns are back on listings and the migration
     *  that drops them is not yet recorded. */
    const downgradeToLegacyImageColumns = async (): Promise<void> => {
      await getDb().executeMultiple(
        "ALTER TABLE listings ADD COLUMN image_url TEXT NOT NULL DEFAULT '';" +
          "ALTER TABLE listings ADD COLUMN image_thumb_url TEXT NOT NULL DEFAULT '';",
      );
      await getDb().execute({
        args: [FIRST_CLASS_IMAGES_ID],
        sql: "DELETE FROM schema_migrations WHERE id = ?",
      });
      await getDb().execute(
        "UPDATE settings SET value = 'pre-images' WHERE key = 'db_schema_hash'",
      );
    };

    test("restores the legacy column and replays the migration on next boot", async () => {
      // Create the listing first: the admin route it posts through runs
      // initDb, which would replay the un-recorded migration and drop the
      // legacy columns again if the downgrade had already happened.
      await createTestListing({ name: "Legacy Image Listing" });
      await downgradeToLegacyImageColumns();
      await getDb().execute(
        "UPDATE listings SET image_url = 'legacy-image-cipher'",
      );
      const zip = await createBackupZip();

      await restoreFromZip(zip);

      // The replayed dump carried the since-dropped column; the restore must
      // re-add it so the data survives for the pending migration to pick up.
      const replayed = await queryOne<{ image_url: string }>(
        "SELECT image_url FROM listings",
      );
      expect(replayed?.image_url).toBe("legacy-image-cipher");

      // The next boot sees the restored (older) markers and replays the
      // pending migration: the image is promoted to a first-class record and
      // the legacy columns are dropped again.
      await initDb();
      const image = await queryOne<{
        filename: string;
        filename_thumb: string;
      }>("SELECT filename, filename_thumb FROM images");
      expect(image?.filename).toBe("legacy-image-cipher");
      expect(image?.filename_thumb).toBe("legacy-image-cipher");
      const use = await queryOne<{ item_type: string }>(
        "SELECT item_type FROM image_uses",
      );
      expect(use?.item_type).toBe("listing");
      expect(await listingColumnNames()).not.toContain("image_url");
    });
  });
});
