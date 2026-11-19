/**
 * Fixtures for tests that read an item's projected image fields. Both item
 * readers report the same three columns, so one case table drives each
 * reader's check.
 */

import { expect } from "@std/expect";
import { getImageFilenamesForItem, insertImageRecord } from "#db/images.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import { requireValue } from "#shared/required-value.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { insertBrokenImage } from "#test-utils/admin-images.ts";
import type { ItemImageColumns } from "#types";

/** A broken image row with a working thumbnail, so tests can see that only the
 * unreadable column falls back to the marker. */
export const insertBrokenImageWithGoodThumb = (): Promise<number> =>
  insertBrokenImage({ thumbFilename: "broken-thumb.webp" });

/** One read's image fields, compared field by field. A wider record passes the
 * same checks a partial match makes, and a narrower one fails on every field
 * the read omits. */
export const expectImageFields = (
  actual: ItemImageColumns,
  expected: ItemImageColumns,
): void => {
  expect(actual).toMatchObject(expected);
};

/** One stored listing as its image fields; a missing listing fails the read. */
const listingFieldsOf = async (id: number): Promise<ItemImageColumns> =>
  requireValue(await getListingWithCount(id), `Listing ${id} is missing`);

/** A stored image whose filename or thumbnail decrypts empty projects the
 * marker instead. */
const BROKEN_IMAGE_FIELDS: ItemImageColumns = {
  imageAltText: "",
  imageThumbUrl: "broken-thumb.webp",
  imageUrl: BROKEN_IMAGE_FILENAME,
};

/** A stored image whose row spells the fields `expected` projects. */
export const addProjectedImage = async (
  name: string,
  expected: ItemImageColumns,
): Promise<number> =>
  (
    await insertImageRecord({
      altText: expected.imageAltText,
      filename: nonEmptyString(expected.imageUrl, "projected image filename"),
      filenameThumb: nonEmptyString(
        expected.imageThumbUrl,
        "projected image thumbnail filename",
      ),
      name,
    })
  ).id;

/** Each projection test: one stored image, one reader, the fields it reports.
 * A broken image keeps its marker fields whatever the case name. */
export const projectionCases: readonly {
  broken?: true;
  expected: ItemImageColumns;
  read: (listingId: number) => Promise<ItemImageColumns>;
  report?: (ids: { imageId: number; listingId: number }) => string;
  title: string;
}[] = [
  {
    broken: true,
    expected: BROKEN_IMAGE_FIELDS,
    read: (listingId) => getImageFilenamesForItem("listing", listingId),
    report: ({ imageId }) =>
      `image ${imageId} filename decrypted to an empty value`,
    title: "projects the broken-image marker for an item's first image",
  },
  {
    broken: true,
    expected: BROKEN_IMAGE_FIELDS,
    read: listingFieldsOf,
    report: ({ listingId }) => `listing ${listingId} image`,
    title: "projects the broken-image marker through listing reads",
  },
  {
    expected: {
      imageAltText: "Primary image alt",
      imageThumbUrl: "primary-thumb.webp",
      imageUrl: "primary.webp",
    },
    read: (listingId) => getImageFilenamesForItem("listing", listingId),
    title: "projects the primary image filenames and alt text for an item",
  },
  {
    expected: {
      imageAltText: "Projected image alt",
      imageThumbUrl: "projected-thumb.webp",
      imageUrl: "projected.webp",
    },
    read: listingFieldsOf,
    title: "projects listing images through listing reads",
  },
];
