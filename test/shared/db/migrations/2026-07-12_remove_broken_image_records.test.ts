import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { execute, queryAll } from "#shared/db/client.ts";
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
      await insertBrokenImage({ name: "Also broken" });
      await setImagesForItem("listing", listing.id, [brokenId, real.id]);

      await runMigration();

      // Both broken records and the one's link are gone; the real image and
      // its link survive at its original sort order.
      const remainingIds = await queryAll<{ id: number }>(
        "SELECT id FROM images ORDER BY id",
      );
      expect(remainingIds.map((row) => row.id)).toEqual([real.id]);
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

    test("fails loudly on a filename that will not decrypt, deleting nothing", async () => {
      const listing = await createTestListing({ name: "Aborted repair" });
      const kept = await makeImage("Kept");
      // Seeded BEFORE the malformed row, so the scan (which walks ids in
      // order) has already identified this broken record when the malformed
      // one throws — a regression that deletes as it scans would remove it.
      const brokenId = await insertBrokenImage();
      await setImagesForItem("listing", listing.id, [brokenId]);
      const malformed = await execute(
        `INSERT INTO images (name, filename, filename_thumb, alt_text)
         VALUES (?, 'not-a-ciphertext', 'not-a-ciphertext', '')`,
        [await encrypt("Unknown corruption")],
      );
      const malformedId = Number(malformed.lastInsertRowid);

      // Unknown corruption is not the known encrypted-empty shape, so the
      // migration must stop rather than guess that deleting data is safe.
      await expect(runMigration()).rejects.toThrow(
        "Invalid encrypted data format",
      );
      // Every record survives — including the already-identified broken one
      // and its item link, because deletes only run after the full scan.
      const remaining = await queryAll<{ id: number }>(
        "SELECT id FROM images ORDER BY id",
      );
      expect(remaining.map((row) => row.id)).toEqual([
        kept.id,
        brokenId,
        malformedId,
      ]);
      expect(await getImageUsesForImage(brokenId)).toEqual([
        {
          image_id: brokenId,
          item_id: listing.id,
          item_type: "listing",
          sort_order: 0,
        },
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
