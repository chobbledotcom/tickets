import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { getImagesForItem } from "#shared/db/images.ts";
import firstClassImagesMigration from "#shared/db/migrations/2026-07-05_first_class_images.ts";
import {
  applySchemaChanges,
  recreateTable,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import type { MigrationContext } from "#shared/db/migrations/types.ts";
import { additive } from "#shared/db/migrations/verify.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";
import { columnNames, tableRowCount } from "../migration-test-helpers.ts";

// The real additive() (not the no-op stub) so runMigration's verify() genuinely
// checks the tables and indexes the migration's `requires` claims.
const context = buildMigrationContext({
  additive,
  applySchemaChanges,
  recreateTable,
  syncIndexes,
});

/** Mirror the production runner: a migration only counts as applied once
 * verify() confirms the objects its `requires` claims actually landed. */
const runMigration = async (): Promise<void> => {
  const migration = firstClassImagesMigration(context);
  await migration.up();
  await migration.verify();
};

const addListingImageUrlColumn = (): Promise<unknown> =>
  getDb().execute(
    "ALTER TABLE listings ADD COLUMN image_url TEXT NOT NULL DEFAULT ''",
  );

const addListingImageThumbColumn = (): Promise<unknown> =>
  getDb().execute(
    "ALTER TABLE listings ADD COLUMN image_thumb_url TEXT NOT NULL DEFAULT ''",
  );

const addListingImageColumns = async (): Promise<void> => {
  await addListingImageUrlColumn();
  await addListingImageThumbColumn();
};

/** Stamp a legacy listing image the way production wrote it: ciphertext for a
 * set value, a literal `''` for "no value" (see `col.encryptedText`). */
const setListingImageColumns = async (
  listingId: number,
  filename: string,
  thumbnail: string,
): Promise<unknown> =>
  getDb().execute({
    args: [
      await encrypt(filename),
      thumbnail === "" ? "" : await encrypt(thumbnail),
      listingId,
    ],
    sql: "UPDATE listings SET image_url = ?, image_thumb_url = ? WHERE id = ?",
  });

const imageUseRows = (): Promise<
  { image_id: number; item_id: number; item_type: string; sort_order: number }[]
> =>
  queryAll(
    "SELECT image_id, item_type, item_id, sort_order FROM image_uses ORDER BY item_id",
  );

const expectListingImageColumnsGone = async (): Promise<void> => {
  const columns = await columnNames("listings");
  expect(columns).not.toContain("image_url");
  expect(columns).not.toContain("image_thumb_url");
};

describeWithEnv(
  "db > migrations > 2026-07-05_first_class_images",
  { db: true },
  () => {
    test("moves each listing image into a linked first-class record", async () => {
      await addListingImageColumns();
      const pictured = await createTestListing({ name: "Poster listing" });
      const bare = await createTestListing({ name: "Bare listing" });
      await setListingImageColumns(
        pictured.id,
        "products/full.webp",
        "products/thumb.webp",
      );

      await runMigration();

      await expectListingImageColumnsGone();
      // The record decrypts back to the exact uploaded filenames and inherits
      // the listing's name (the admin UI requires one and uses it as the alt
      // fallback); the legacy system had no alt text.
      expect(await getImagesForItem("listing", pictured.id)).toEqual([
        {
          alt_text: "",
          filename: "products/full.webp",
          filename_thumb: "products/thumb.webp",
          id: pictured.id,
          name: "Poster listing",
          sort_order: 0,
        },
      ]);
      expect(await getImagesForItem("listing", bare.id)).toEqual([]);
      expect(await imageUseRows()).toEqual([
        {
          image_id: pictured.id,
          item_id: pictured.id,
          item_type: "listing",
          sort_order: 0,
        },
      ]);
    });

    test("reuses the full image as thumbnail for listings that predate thumbnails", async () => {
      await addListingImageColumns();
      const listing = await createTestListing({ name: "Pre-thumb listing" });
      await setListingImageColumns(listing.id, "products/full.webp", "");

      await runMigration();

      const [image] = await getImagesForItem("listing", listing.id);
      expect(image!.filename).toBe("products/full.webp");
      expect(image!.filename_thumb).toBe("products/full.webp");
    });

    test("backfills a database whose listings never had the thumbnail column", async () => {
      await addListingImageUrlColumn();
      const listing = await createTestListing({ name: "Ancient listing" });
      await getDb().execute({
        args: [await encrypt("products/old.webp"), listing.id],
        sql: "UPDATE listings SET image_url = ? WHERE id = ?",
      });

      await runMigration();

      await expectListingImageColumnsGone();
      const [image] = await getImagesForItem("listing", listing.id);
      expect(image!.filename).toBe("products/old.webp");
      expect(image!.filename_thumb).toBe("products/old.webp");
    });

    test("does not duplicate image records when the rebuild is retried", async () => {
      // A crash between the backfill and the listings rebuild leaves the copied
      // rows behind with the legacy columns still present; the runner re-runs
      // up(), so the second backfill must land on the same rows, not new ones.
      let rebuilds = 0;
      const failOnceContext = buildMigrationContext({
        applySchemaChanges,
        recreateTable: async (
          table: Parameters<MigrationContext["recreateTable"]>[0],
        ) => {
          rebuilds += 1;
          if (rebuilds === 1) throw new Error("evicted mid-rebuild");
          await recreateTable(table);
        },
        syncIndexes,
      });
      const retriedMigration = () =>
        firstClassImagesMigration(failOnceContext).up();
      await addListingImageColumns();
      const listing = await createTestListing({ name: "Poster listing" });
      await setListingImageColumns(
        listing.id,
        "products/full.webp",
        "products/thumb.webp",
      );

      await expect(retriedMigration()).rejects.toThrow("evicted mid-rebuild");
      await retriedMigration();

      await expectListingImageColumnsGone();
      expect(await tableRowCount("images")).toBe(1);
      expect(await imageUseRows()).toEqual([
        {
          image_id: listing.id,
          item_id: listing.id,
          item_type: "listing",
          sort_order: 0,
        },
      ]);
    });

    test("is a no-op once the listing image columns are already gone", async () => {
      await runMigration();
      await expectListingImageColumnsGone();
      expect(await tableRowCount("images")).toBe(0);
      expect(await imageUseRows()).toEqual([]);
    });

    test("keeps its recorded marker identity", () => {
      // The id keys the applied-migrations marker — changing it would re-run
      // the migration on every deployed site — and the description is stored
      // beside it for operators.
      const migration = firstClassImagesMigration(context);
      expect(migration.id).toBe("2026-07-05_first_class_images");
      expect(migration.description).toBe(
        "Create first-class images and image_uses tables.",
      );
    });
  },
);
