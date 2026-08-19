import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { executeBatch, queryAll } from "#db/client.ts";
import {
  appendImageToItem,
  clearImageUsesForItemStatement,
  deleteImageRecord,
  getAllImages,
  getImageById,
  getImageFilenamesForItem,
  getImagesForItem,
  imagesTable,
  imageUseTargets,
  setImagesForItem,
  setItemsForImage,
} from "#db/images.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { insertBrokenImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import type { Image } from "#types";

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

/** A broken image row with a working thumbnail, so tests can see that only
 * the unreadable column falls back to the marker. */
const insertBrokenImageWithGoodThumb = (): Promise<number> =>
  insertBrokenImage({ thumbFilename: "broken-thumb.webp" });

describeWithEnv("db > images", { db: true }, () => {
  const errors = setupErrorSpy();

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

    test("swaps in the broken-image marker when a filename decrypts empty", async () => {
      const id = await insertBrokenImageWithGoodThumb();

      const images = await getAllImages();
      expect(images.map((image) => image.id)).toEqual([id]);
      expect(images[0]?.filename).toBe(BROKEN_IMAGE_FILENAME);
      expect(images[0]?.filename_thumb).toBe("broken-thumb.webp");
      expect(images[0]?.name).toBe("Broken");
      expect(errors.lastMessage()).toContain("E_IMAGE_BROKEN");
      expect(errors.lastMessage()).toContain(
        `image ${id} filename decrypted to an empty value`,
      );
    });

    test("projects the broken-image marker for an item's first image", async () => {
      const listing = await createTestListing({ name: "Broken poster" });
      const id = await insertBrokenImageWithGoodThumb();
      await setImagesForItem("listing", listing.id, [id]);

      expect(await getImageFilenamesForItem("listing", listing.id)).toEqual({
        image_alt_text: "",
        image_thumb_url: "broken-thumb.webp",
        image_url: BROKEN_IMAGE_FILENAME,
      });
      expect(errors.lastMessage()).toContain(
        `image ${id} (first image of listing ${listing.id}) filename decrypted to an empty value`,
      );
    });

    test("projects the broken-image marker through listing reads", async () => {
      const listing = await createTestListing({ name: "Broken projection" });
      const id = await insertBrokenImageWithGoodThumb();
      await setImagesForItem("listing", listing.id, [id]);

      expect(await getListingWithCount(listing.id)).toMatchObject({
        image_alt_text: "",
        image_thumb_url: "broken-thumb.webp",
        image_url: BROKEN_IMAGE_FILENAME,
      });
      expect(errors.contains(`listing ${listing.id} image`)).toBe(true);
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
        clearImageUsesForItemStatement(
          imageUseTargets.of("listing")(listing.id),
        ),
      ]);
      expect(await linkedImageIds("listing", listing.id)).toEqual([]);
    });

    test("appends one image link at the next item sort order", async () => {
      const listing = await createTestListing({ name: "Append listing" });
      const existing = await makeImage("Existing");
      const uploaded = await makeImage("Uploaded");
      await setImagesForItem("listing", listing.id, [existing.id]);

      await appendImageToItem(uploaded.id, {
        id: listing.id,
        kind: "listing",
      });
      await appendImageToItem(uploaded.id, {
        id: listing.id,
        kind: "listing",
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
        { id: listing.id, kind: "listing" },
        { id: listing.id, kind: "listing" },
        { id: group.id, kind: "group" },
        { id: 9999, kind: "group" },
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

      await setItemsForImage(edited.id, [{ id: listing.id, kind: "listing" }]);

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
        { id: listing.id, kind: "listing" },
        { id: group.id, kind: "group" },
      ]);

      await setItemsForImage(image.id, []);

      expect(await linkedImageIds("listing", listing.id)).toEqual([]);
      expect(await linkedImageIds("group", group.id)).toEqual([]);
    });
  });
});
