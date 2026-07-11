import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createBackupZip,
  exportTable,
  PostResetError,
  restoreFromSql,
  restoreFromZip,
} from "#shared/db/backup.ts";
import { getDb, queryAll, queryOne } from "#shared/db/client.ts";
import { initDb } from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
  const listingCount = async (): Promise<number> =>
    (await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM listings"))!.n;

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

  describe("backups this build cannot replay", () => {
    test("a backup from a newer build is refused before anything is wiped", async () => {
      await createTestListing({ name: "Still Here" });
      const recorded = await exportTable("schema_migrations");
      const dump =
        `${recorded.sql}\n` +
        `INSERT INTO "schema_migrations" ("id", "description", "applied_at") ` +
        `VALUES ('2099-01-01_from_the_future', 'Future change', '2099-01-01T00:00:00.000Z');\n`;

      await expect(restoreFromSql(dump)).rejects.toThrow(
        "2099-01-01_from_the_future",
      );

      // Refused up front: the database was never reset, so the data survives.
      expect(await listingCount()).toBe(1);
    });

    test("an orphaned marker from a historically renamed migration is not refused", async () => {
      // Real databases carry schema_migrations rows whose migration was later
      // renamed (e.g. 2026-06-18_answer_price_modifiers); the old marker is
      // never cleaned up, so its unrecognised id must not read as "newer".
      await createTestListing({ name: "Orphan Marker Survivor" });
      const recorded = await exportTable("schema_migrations");
      const dump =
        `${recorded.sql}\n` +
        `INSERT INTO "schema_migrations" ("id", "description", "applied_at") ` +
        `VALUES ('2026-06-18_answer_price_modifiers', 'Renamed since', '2026-06-18T00:00:00.000Z');\n` +
        `${(await exportTable("listings")).sql}\n`;

      await restoreFromSql(dump);

      expect(await listingCount()).toBe(1);
    });

    test("an unknown column with no pending migration fails instead of being re-added", async () => {
      // The dump records every known migration, so nothing pending could
      // consume a stray column — it is corruption, and the INSERT must fail.
      const recorded = await exportTable("schema_migrations");
      const dump =
        `${recorded.sql}\n` +
        `INSERT INTO "holidays" ("id", "date", "stray_col") VALUES (1, '2026-01-01', 'x');\n`;

      await expect(restoreFromSql(dump)).rejects.toThrow(PostResetError);
      const holidayColumns = await queryAll<{ name: string }>(
        "SELECT name FROM pragma_table_info('holidays')",
      );
      expect(holidayColumns.map((c) => c.name)).not.toContain("stray_col");
    });
  });
});
