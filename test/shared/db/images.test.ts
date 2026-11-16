import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { executeBatch, queryAll } from "#db/client.ts";
import {
  addPageImageUrls,
  addTicketPageImageUrls,
  imageUrlsFor,
} from "#db/image-urls.ts";
import { appendImageToItem, clearImageUsesForItemStatement, deleteImageRecord, getAllImages, getImageById, getImageFilenamesForItem, getImageUsesForImage, getImagesForItem, imageUseTargets, insertImageRecord, setImagesForItem, setItemsForImage } from "#db/images.ts";
import { sql } from "#db/sql.ts";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import {
  currentRequestStore,
  getPageImageUrls,
} from "#shared/request-context.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { insertBrokenImage } from "#test-utils/admin-images.ts";
import { expectEncryptedAtRest } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  addProjectedImage,
  expectImageFields,
  insertBrokenImageWithGoodThumb,
  projectionCases,
} from "#test-utils/image-projections.ts";
import { expectQueryRows } from "#test-utils/query-rows.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { Image } from "#types";

const makeImage = (
  name: string,
  extra: Partial<{
    altText: string;
    filename: string;
    filenameThumb: string;
  }> = {},
): Promise<Image> =>
  insertImageRecord({
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

/** Two new stored images, named in creation order. */
const createImagePair = async (name: string) => {
  const first = await makeImage(`${name} first`);
  const second = await makeImage(`${name} second`);
  return { first, second };
};

/** One stored listing, one stored group and one stored image that neither item
 * holds yet. */
const linkedItemSet = async (name: string) => {
  const listing = await createTestListing({ name: `${name} listing` });
  const group = await createTestGroup({ name: `${name} group` });
  const image = await makeImage(name);
  return { group, image, listing };
};

/** A listing that holds `linked` and no other image, plus a `spare` image on
 * no item. */
const listingWithSpareImage = async (name: string) => {
  const listing = await createTestListing({ name: `${name} listing` });
  const { first: linked, second: spare } = await createImagePair(name);
  await setImagesForItem("listing", listing.id, [linked.id]);
  return { linked, listing, spare };
};

/** A stored image whose filename or thumbnail decrypts empty falls back to the
 * marker and reports the column it could not read. */
const brokenImageCases: readonly {
  expected: { filename: string; filename_thumb: string; name: string };
  insertImage: () => Promise<number>;
  report: (id: number) => string;
  title: string;
}[] = [
  {
    expected: {
      filename: BROKEN_IMAGE_FILENAME,
      filename_thumb: "broken-thumb.webp",
      name: "Broken",
    },
    insertImage: insertBrokenImageWithGoodThumb,
    report: (id) => `image ${id} filename decrypted to an empty value`,
    title: "swaps in the broken-image marker when a filename decrypts empty",
  },
  {
    expected: {
      filename: BROKEN_IMAGE_FILENAME,
      filename_thumb: BROKEN_IMAGE_FILENAME,
      name: "Broken",
    },
    insertImage: insertBrokenImage,
    report: (id) =>
      `image ${id} thumbnail filename decrypted to an empty value`,
    title: "names a broken thumbnail in its report",
  },
];

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
        sql`SELECT name, filename, filename_thumb, alt_text FROM images WHERE id = ${image.id}`,
      );
      expectEncryptedAtRest(
        raw?.name,
        raw?.filename,
        raw?.filename_thumb,
        raw?.alt_text,
      );
      assert(!raw!.name.includes("Hero"));

      expect(await getImageById(image.id)).toEqual(image);
      expect(await getAllImages()).toEqual([image]);
      expect(await getImageById(9999)).toBeNull();
    });

    for (const brokenImage of brokenImageCases) {
      test(brokenImage.title, async () => {
        const id = await brokenImage.insertImage();

        const images = await getAllImages();
        expect(images.map((image) => image.id)).toEqual([id]);
        expect(images[0]).toMatchObject(brokenImage.expected);
        expect(errors.contains("E_IMAGE_BROKEN")).toBe(true);
        expect(errors.contains(brokenImage.report(id))).toBe(true);
      });
    }
  });

  describe("item links", () => {
    for (const projection of projectionCases) {
      test(projection.title, async () => {
        const listing = await createTestListing({ name: projection.title });
        const imageId = projection.broken
          ? await insertBrokenImageWithGoodThumb()
          : await addProjectedImage(projection.title, projection.expected);
        await setImagesForItem("listing", listing.id, [imageId]);

        expectImageFields(
          await projection.read(listing.id),
          projection.expected,
        );
        const report = projection.report;
        if (report) {
          expect(
            errors.contains(report({ imageId, listingId: listing.id })),
          ).toBe(true);
        }
      });
    }

    test("uses the declared table for page and news targets", () => {
      const statement = sql`${imageUseTargets.existsSql("news", 7)} AND ${imageUseTargets.existsSql("page", 8)}`;
      expect(statement.sql).toBe(
        "EXISTS (SELECT 1 FROM news_posts WHERE id = ?1)" +
          " AND EXISTS (SELECT 1 FROM site_pages WHERE id = ?2)",
      );
      expect(statement.args).toEqual([7, 8]);
    });

    test("returns empty image fields for an item without an image", async () => {
      expect(await getImageFilenamesForItem("listing", 9999)).toEqual({
        image_alt_text: "",
        image_thumb_url: "",
        image_url: "",
      });
    });

    test("sets one item's ordered images through the collection path", async () => {
      const listing = await createTestListing({ name: "Poster listing" });
      const { first, second } = await createImagePair("Poster");

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
      const {
        linked: existing,
        listing,
        spare: uploaded,
      } = await listingWithSpareImage("Append");

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
      await expectQueryRows<{ image_id: number; sort_order: number }>(
        sql`SELECT image_id, sort_order
             FROM image_uses
            WHERE item_type = ${"listing"} AND item_id = ${listing.id}
            ORDER BY sort_order ASC, image_id ASC`,
        [
          { image_id: existing.id, sort_order: 0 },
          { image_id: uploaded.id, sort_order: 1 },
        ],
      );
    });

    test("sets all item links for one image and appends to existing item order", async () => {
      const { group, image, listing } = await linkedItemSet("Linked");
      const existing = await makeImage("Existing");
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
      await expectQueryRows<{ item_id: number; item_type: string }>(
        sql`SELECT item_type, item_id FROM image_uses
            WHERE image_id = ${image.id} ORDER BY item_type, item_id`,
        [
          { item_id: group.id, item_type: "group" },
          { item_id: listing.id, item_type: "listing" },
        ],
      );
      expect(await getImageUsesForImage(image.id)).toEqual([
        {
          image_id: image.id,
          item_id: group.id,
          item_type: "group",
          sort_order: 0,
        },
        {
          image_id: image.id,
          item_id: listing.id,
          item_type: "listing",
          sort_order: 1,
        },
      ]);

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
      const { group, image, listing } = await linkedItemSet("Unlinked");
      await setItemsForImage(image.id, [
        { id: listing.id, kind: "listing" },
        { id: group.id, kind: "group" },
      ]);

      await setItemsForImage(image.id, []);

      expect(await linkedImageIds("listing", listing.id)).toEqual([]);
      expect(await linkedImageIds("group", group.id)).toEqual([]);
    });
  });

  describe("page image urls", () => {
    /** The request's page-image slot as id-sorted [id, url] pairs. */
    const slotEntries = (): [number, string][] =>
      [...(currentRequestStore()?.pageImageUrls ?? [])].sort(
        (a, b) => a[0] - b[0],
      );

    test("writes one ticket page's references into the request's page-image slot", async () => {
      const poster = await makeImage("Poster");
      const kit = await makeImage("Kit");
      const coast = await makeImage("Coast");
      const dune = await makeImage("Dune");
      const anchor = await makeImage("Anchor");
      const beacon = await makeImage("Beacon");

      await withRequestContext(async () => {
        await addTicketPageImageUrls({
          footer: `![Beacon](img#${beacon.id})`,
          groupDescription: `![Coast](img#${coast.id})`,
          listings: [
            { listing: { description: null } },
            { listing: { description: `![Poster](img#${poster.id})` } },
          ],
          packages: [
            { description: "plain words" },
            {
              description: `![Anchor](img#${anchor.id}) ![Ghost](img#424242) img#0`,
            },
          ],
          questions: [
            { text: "no image named here" },
            { text: `![Kit](img#${kit.id})` },
          ],
          terms: `![Dune](img#${dune.id})`,
        });

        expect(slotEntries()).toEqual([
          [poster.id, "/image/poster.webp"],
          [kit.id, "/image/kit.webp"],
          [coast.id, "/image/coast.webp"],
          [dune.id, "/image/dune.webp"],
          [anchor.id, "/image/anchor.webp"],
          [beacon.id, "/image/beacon.webp"],
        ]);
      });
    });

    test("adds one page's urls beside an earlier loader's", async () => {
      const poster = await makeImage("Poster");
      const anchor = await makeImage("Anchor");

      await withRequestContext(async () => {
        await addPageImageUrls([`![Poster](img#${poster.id})`]);
        await addTicketPageImageUrls({
          listings: [],
          packages: [{ description: `![Anchor](img#${anchor.id})` }],
          questions: [],
        });

        expect(slotEntries()).toEqual([
          [poster.id, "/image/poster.webp"],
          [anchor.id, "/image/anchor.webp"],
        ]);
      });
    });

    test("writes an empty slot when no text names an image", async () => {
      await withRequestContext(async () => {
        await addTicketPageImageUrls({
          listings: [{ listing: { description: null } }],
          packages: [{ description: "plain words only" }],
          questions: [],
        });

        expect(getPageImageUrls().size).toBe(0);
      });
    });

    test("stays silent outside a request", async () => {
      await addPageImageUrls(["![Poster](img#1)"]);
      await addTicketPageImageUrls({
        listings: [],
        packages: [{ description: "![Anchor](img#2)" }],
        questions: [],
      });

      expect(currentRequestStore()).toBe(undefined);
    });
  });

  describe("image urls for references", () => {
    test("answers an overlong img# reference with no image", async () => {
      // A 400-digit id overflows to Infinity, which no binder accepts.
      const urls = await imageUrlsFor([`![Poster](img#${"9".repeat(400)})`]);

      expect(urls.size).toBe(0);
    });
  });
});
