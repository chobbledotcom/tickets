import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { execute, executeBatch, queryAll } from "#shared/db/client.ts";
import {
  appendImageToItem,
  clearImageUsesForItemStatement,
  deleteImageRecord,
  getAllImages,
  getImageById,
  getImageFilenamesForItem,
  getImagesForItem,
  imagesTable,
  setImagesForItem,
  setItemsForImage,
} from "#shared/db/images.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import type { Image } from "#shared/types.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const makeImage = (
  name: string,
  extra: Partial<{
    altText: string;
    filename: string;
    filenameThumb: string;
  }> = {},
): Promise<Image> =>
  imagesTable.insert({
    altText: extra.altText ?? `Alt ${name}`,
    filename: nonEmptyString(
      extra.filename ?? `${name.toLowerCase()}.webp`,
      "test image filename",
    ),
    filenameThumb: nonEmptyString(
      extra.filenameThumb ?? `${name.toLowerCase()}-thumb.webp`,
      "test image thumbnail filename",
    ),
    name,
  });

const linkedImageIds = async (
  itemType: "listing" | "group",
  itemId: number,
): Promise<number[]> =>
  (await getImagesForItem(itemType, itemId)).map((image) => image.id);

describeWithEnv("db > images", { db: true }, () => {
  describe("image metadata", () => {
    test("stores free text encrypted and decrypts image reads", async () => {
      const image = await makeImage("Hero", {
        altText: "A stage lit in red",
        filename: "hero.webp",
        filenameThumb: "hero-thumb.webp",
      });

      const [raw] = await queryAll<{
        alt_text: string;
        filename: string;
        filename_thumb: string;
        name: string;
      }>(
        "SELECT name, filename, filename_thumb, alt_text FROM images WHERE id = ?",
        [image.id],
      );
      expect(raw?.name.startsWith("enc:")).toBe(true);
      expect(raw?.filename.startsWith("enc:")).toBe(true);
      expect(raw?.filename_thumb.startsWith("enc:")).toBe(true);
      expect(raw?.alt_text.startsWith("enc:")).toBe(true);
      expect(raw?.name).not.toContain("Hero");

      expect(await getImageById(image.id)).toEqual(image);
      expect(await getAllImages()).toEqual([image]);
      expect(await getImageById(9999)).toBeNull();
    });

    test("rejects stored images whose filename decrypts to an empty string", async () => {
      await execute(
        `INSERT INTO images (name, filename, filename_thumb, alt_text)
         VALUES (?, ?, ?, ?)`,
        [
          await encrypt("Broken"),
          await encrypt(""),
          await encrypt("broken-thumb.webp"),
          "",
        ],
      );

      await expect(getAllImages()).rejects.toThrow(
        "image filename must be non-empty",
      );
    });
  });

  describe("item links", () => {
    test("sets one item's ordered images through the collection path", async () => {
      const listing = await createTestListing({ name: "Poster listing" });
      const first = await makeImage("First");
      const second = await makeImage("Second");

      await setImagesForItem("listing", listing.id, [
        second.id,
        9999,
        first.id,
        second.id,
      ]);

      expect(await linkedImageIds("listing", listing.id)).toEqual([
        second.id,
        first.id,
      ]);

      await executeBatch([
        clearImageUsesForItemStatement("listing", listing.id),
      ]);
      expect(await linkedImageIds("listing", listing.id)).toEqual([]);
    });

    test("appends one image link at the next item sort order", async () => {
      const listing = await createTestListing({ name: "Append listing" });
      const existing = await makeImage("Existing");
      const uploaded = await makeImage("Uploaded");
      await setImagesForItem("listing", listing.id, [existing.id]);

      await appendImageToItem(uploaded.id, {
        itemId: listing.id,
        itemType: "listing",
      });
      await appendImageToItem(uploaded.id, {
        itemId: listing.id,
        itemType: "listing",
      });

      expect(await linkedImageIds("listing", listing.id)).toEqual([
        existing.id,
        uploaded.id,
      ]);
      expect(
        await queryAll<{ image_id: number; sort_order: number }>(
          `SELECT image_id, sort_order
             FROM image_uses
            WHERE item_type = ? AND item_id = ?
            ORDER BY sort_order ASC, image_id ASC`,
          ["listing", listing.id],
        ),
      ).toEqual([
        { image_id: existing.id, sort_order: 0 },
        { image_id: uploaded.id, sort_order: 1 },
      ]);
    });

    test("projects the primary image filenames and alt text for an item", async () => {
      const listing = await createTestListing({ name: "Alt listing" });
      const image = await makeImage("Primary", {
        altText: "Primary image alt",
        filename: "primary.webp",
        filenameThumb: "primary-thumb.webp",
      });
      await setImagesForItem("listing", listing.id, [image.id]);

      expect(await getImageFilenamesForItem("listing", listing.id)).toEqual({
        image_alt_text: "Primary image alt",
        image_thumb_url: "primary-thumb.webp",
        image_url: "primary.webp",
      });
    });

    test("projects listing images through listing reads", async () => {
      const listing = await createTestListing({ name: "Projected listing" });
      const image = await makeImage("Projected", {
        altText: "Projected image alt",
        filename: "projected.webp",
        filenameThumb: "projected-thumb.webp",
      });
      await setImagesForItem("listing", listing.id, [image.id]);

      expect(await getListingWithCount(listing.id)).toMatchObject({
        image_alt_text: "Projected image alt",
        image_thumb_url: "projected-thumb.webp",
        image_url: "projected.webp",
      });
    });

    test("sets all item links for one image and appends to existing item order", async () => {
      const listing = await createTestListing({ name: "Linked listing" });
      const group = await createTestGroup({ name: "Linked group" });
      const existing = await makeImage("Existing");
      const image = await makeImage("Reusable");
      await setImagesForItem("listing", listing.id, [existing.id]);

      await setItemsForImage(image.id, [
        { itemId: listing.id, itemType: "listing" },
        { itemId: listing.id, itemType: "listing" },
        { itemId: group.id, itemType: "group" },
        { itemId: 9999, itemType: "group" },
      ]);

      expect(await linkedImageIds("listing", listing.id)).toEqual([
        existing.id,
        image.id,
      ]);
      expect(await linkedImageIds("group", group.id)).toEqual([image.id]);

      await deleteImageRecord(image.id);
      expect(await getImageById(image.id)).toBeNull();
      expect(await linkedImageIds("listing", listing.id)).toEqual([
        existing.id,
      ]);
      expect(await linkedImageIds("group", group.id)).toEqual([]);
    });

    test("preserves existing item image order when saving one image's links", async () => {
      const listing = await createTestListing({ name: "Stable listing" });
      const edited = await makeImage("Edited");
      const trailing = await makeImage("Trailing");
      await setImagesForItem("listing", listing.id, [edited.id, trailing.id]);

      await setItemsForImage(edited.id, [
        { itemId: listing.id, itemType: "listing" },
      ]);

      expect(await linkedImageIds("listing", listing.id)).toEqual([
        edited.id,
        trailing.id,
      ]);
    });

    test("clears every link for an image when saving no item links", async () => {
      const listing = await createTestListing({ name: "Unlinked listing" });
      const group = await createTestGroup({ name: "Unlinked group" });
      const image = await makeImage("Unlinked");
      await setItemsForImage(image.id, [
        { itemId: listing.id, itemType: "listing" },
        { itemId: group.id, itemType: "group" },
      ]);

      await setItemsForImage(image.id, []);

      expect(await linkedImageIds("listing", listing.id)).toEqual([]);
      expect(await linkedImageIds("group", group.id)).toEqual([]);
    });
  });
});
