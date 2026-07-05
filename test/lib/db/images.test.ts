import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { executeBatch, queryAll } from "#shared/db/client.ts";
import {
  clearImageUsesForItemStatement,
  deleteImageRecord,
  getAllImages,
  getImageById,
  getImagesForItem,
  imagesTable,
  setImagesForItem,
  setItemsForImage,
} from "#shared/db/images.ts";
import type { Image } from "#shared/types.ts";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

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
    filename: extra.filename ?? `${name.toLowerCase()}.webp`,
    filenameThumb: extra.filenameThumb ?? `${name.toLowerCase()}-thumb.webp`,
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
  });
});
