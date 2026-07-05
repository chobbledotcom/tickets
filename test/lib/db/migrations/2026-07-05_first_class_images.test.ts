import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryAll } from "#shared/db/client.ts";
import { getImagesForItem } from "#shared/db/images.ts";
import firstClassImagesMigration from "#shared/db/migrations/2026-07-05_first_class_images.ts";
import {
  applySchemaChanges,
  recreateTable,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import {
  buildMigrationContext,
  createTestListing,
  describeWithEnv,
} from "#test-utils";
import { columnNames } from "../migration-test-helpers.ts";

const context = buildMigrationContext({
  applySchemaChanges,
  recreateTable,
  syncIndexes,
});

const runMigration = () => firstClassImagesMigration(context).up();

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

const setListingImageColumns = async (
  listingId: number,
  filename: string,
  thumbnail: string,
): Promise<unknown> =>
  getDb().execute({
    args: [filename, thumbnail, listingId],
    sql: "UPDATE listings SET image_url = ?, image_thumb_url = ? WHERE id = ?",
  });

const imageUseRows = (): Promise<
  { image_id: number; item_id: number; item_type: string; sort_order: number }[]
> =>
  queryAll(
    "SELECT image_id, item_type, item_id, sort_order FROM image_uses ORDER BY item_id",
  );

describeWithEnv(
  "db > migrations > 2026-07-05_first_class_images",
  { db: true },
  () => {
    test("drops stale listing image columns without creating image rows", async () => {
      await addListingImageColumns();
      const listing = await createTestListing({ name: "Poster listing" });
      await setListingImageColumns(listing.id, "old.webp", "old-thumb.webp");

      await runMigration();

      expect(await columnNames("listings")).not.toContain("image_url");
      expect(await columnNames("listings")).not.toContain("image_thumb_url");
      expect(await getImagesForItem("listing", listing.id)).toEqual([]);
      expect(await imageUseRows()).toEqual([]);
    });

    test("is a no-op once the listing image columns are already gone", async () => {
      await runMigration();
      expect(await columnNames("listings")).not.toContain("image_url");
      expect(await imageUseRows()).toEqual([]);
    });
  },
);
