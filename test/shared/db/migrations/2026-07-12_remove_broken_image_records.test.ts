import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import {
  getAllImages,
  getImageUsesForImage,
  setImagesForItem,
} from "#shared/db/images.ts";
import removeBrokenImageRecords from "#shared/db/migrations/2026-07-12_remove_broken_image_records.ts";
import { insertBrokenImage, makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

// Data-only migration: it scans and deletes image rows via getDb.
const context = buildMigrationContext({});
const runMigration = () => removeBrokenImageRecords(context).up();

describeWithEnv(
  "db > migrations > 2026-07-12_remove_broken_image_records",
  { db: true },
  () => {
    test("deletes broken image records and their item links, keeping real ones", async () => {
      const listing = await createTestListing({ name: "Repaired listing" });
      const real = await makeImage("Real");
      const brokenId = await insertBrokenImage();
      const secondBrokenId = await insertBrokenImage({ name: "Also broken" });
      await setImagesForItem("listing", listing.id, [brokenId, real.id]);

      await runMigration();

      // Both broken records and the one's link are gone; the real image and
      // its link survive at its original sort order.
      const remainingIds = await queryAll<{ id: number }>(
        "SELECT id FROM images ORDER BY id",
      );
      expect(remainingIds.map((row) => row.id)).toEqual([real.id]);
      expect(remainingIds.map((row) => row.id)).not.toContain(secondBrokenId);
      expect(await getImageUsesForImage(brokenId)).toEqual([]);
      expect(await getImageUsesForImage(real.id)).toEqual([
        {
          image_id: real.id,
          item_id: listing.id,
          item_type: "listing",
          sort_order: 1,
        },
      ]);
      // The library reads clean afterwards — nothing left to fall back on.
      expect((await getAllImages()).map((image) => image.name)).toEqual([
        "Real",
      ]);
    });

    test("is a no-op when every image record is readable (idempotent re-run)", async () => {
      const image = await makeImage("Healthy");

      await runMigration();
      await runMigration();

      expect((await getAllImages()).map((row) => row.id)).toEqual([image.id]);
    });
  },
);
