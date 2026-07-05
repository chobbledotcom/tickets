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

const addLegacyImageUrlColumn = (): Promise<unknown> =>
  getDb().execute(
    "ALTER TABLE listings ADD COLUMN image_url TEXT NOT NULL DEFAULT ''",
  );

const addLegacyImageThumbColumn = (): Promise<unknown> =>
  getDb().execute(
    "ALTER TABLE listings ADD COLUMN image_thumb_url TEXT NOT NULL DEFAULT ''",
  );

const addLegacyImageColumns = async (): Promise<void> => {
  await addLegacyImageUrlColumn();
  await addLegacyImageThumbColumn();
};

const setLegacyImage = async (
  listingId: number,
  filename: string,
  thumbnail: string,
): Promise<unknown> =>
  getDb().execute({
    args: [await encrypt(filename), await encrypt(thumbnail), listingId],
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
    test("moves legacy listing images into images and image_uses, then drops the columns", async () => {
      await addLegacyImageColumns();
      const withImage = await createTestListing({
        name: "Legacy poster listing",
      });
      const withoutImage = await createTestListing({
        name: "No legacy image",
      });
      await setLegacyImage(withImage.id, "legacy.webp", "legacy-thumb.webp");

      await runMigration();

      expect(await columnNames("listings")).not.toContain("image_url");
      expect(await columnNames("listings")).not.toContain("image_thumb_url");
      const images = await getImagesForItem("listing", withImage.id);
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({
        alt_text: "",
        filename: "legacy.webp",
        filename_thumb: "legacy-thumb.webp",
        name: "Legacy poster listing",
      });
      expect(await getImagesForItem("listing", withoutImage.id)).toEqual([]);
      expect(await imageUseRows()).toEqual([
        {
          image_id: images[0]!.id,
          item_id: withImage.id,
          item_type: "listing",
          sort_order: 0,
        },
      ]);
    });

    test("backfills an empty thumbnail when only the legacy full image column exists", async () => {
      await addLegacyImageUrlColumn();
      const listing = await createTestListing({ name: "Full image only" });
      await getDb().execute({
        args: [await encrypt("full-only.webp"), listing.id],
        sql: "UPDATE listings SET image_url = ? WHERE id = ?",
      });

      await runMigration();

      expect(await getImagesForItem("listing", listing.id)).toEqual([
        expect.objectContaining({
          filename: "full-only.webp",
          filename_thumb: "",
          name: "Full image only",
        }),
      ]);
    });

    test("is a no-op once the legacy columns are already gone", async () => {
      await runMigration();
      expect(await columnNames("listings")).not.toContain("image_url");
      expect(await imageUseRows()).toEqual([]);
    });
  },
);
