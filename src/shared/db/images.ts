/**
 * First-class uploaded images and their ordered item links.
 */

/* jscpd:ignore-start */
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { StoredRowOf } from "#db/chosen-columns.ts";
import { executeBatch, type SqlStatement, useTransaction } from "#db/client.ts";
import { defineIdTable } from "#db/define-id-table.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { defineOrderedCollection } from "#db/ordered-collection.ts";
import { type Read, readOneRow, readRows } from "#db/read.ts";
import {
  defineRecordTarget,
  ITEM_TARGET_COLUMNS,
  type RecordTarget,
  type RecordTargets,
} from "#db/record-target.ts";
import { type ColumnDef, col } from "#db/table.ts";
import { equals, inList } from "#db/where-clauses.ts";
import { mapById } from "#fp";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import { decryptImageFilename } from "#shared/images/broken.ts";
import {
  currentRequestStore,
  withRequestStore,
} from "#shared/request-context.ts";
import type { NonEmptyString } from "#shared/validation/string.ts";
import {
  type Image,
  type ImageUse,
  type ImageUseItemType,
  ImageUseItemTypeSchema,
  type ItemImageColumns,
} from "#types";
/* jscpd:ignore-end */

export type ImageInput = {
  name: string;
  filename: NonEmptyString;
  filenameThumb: NonEmptyString;
  altText?: string | undefined;
};

/** One record an image can be attached to. */
export type ImageUseTarget = RecordTarget<ImageUseItemType>;

/** How to name and ask for the records images hang off. Each kind lists its
 * table so an attach can insist the record is really there. */
export const imageUseTargets: RecordTargets<ImageUseItemType> =
  defineRecordTarget({
    columns: ITEM_TARGET_COLUMNS,
    kinds: ImageUseItemTypeSchema.options,
    tables: {
      group: "groups",
      listing: "listings",
      news: "news_posts",
      page: "site_pages",
    },
  });

export type OrderedImage = Image & { sort_order: number };

/** Encrypted filename column: sealed on write; on read, a value that will not
 * decrypt to a real filename becomes the broken-image marker (reported, never
 * thrown — one broken record must not take down every page that lists images).
 * The `as` cast is the same sanctioned read boundary as col.encrypted. */
const encryptedFilenameText = (label: string): ColumnDef<NonEmptyString> =>
  ({
    read: (raw: string, rowId?: unknown) =>
      decryptImageFilename(raw, `image ${String(rowId)} ${label}`),
    write: (value: NonEmptyString) => encrypt(value),
  }) as unknown as ColumnDef<NonEmptyString>;

export const imagesTable = defineIdTable<Image, ImageInput>("images", {
  alt_text: col.encryptedText(encrypt, decrypt),
  filename: encryptedFilenameText("filename"),
  filename_thumb: encryptedFilenameText("thumbnail filename"),
  id: col.generated<number>(),
  name: col.encryptedText(encrypt, decrypt),
});

const imageColumns = imagesTable.read.pick([
  "id",
  "name",
  "filename",
  "filename_thumb",
  "alt_text",
]);

export const imageFileColumns = imagesTable.read.pick([
  "id",
  "filename",
  "filename_thumb",
  "alt_text",
]);

const imageUrlColumns = imagesTable.read.pick(["id", "filename"]);

/** The id→uid-URL table the markdown render resolves the editor's `img#N`
 * references against. Each entry maps one referenced image's id to its
 * canonical filename URL, so no image is ever addressable by id. */
export type ImageUrls = ReadonlyMap<number, string>;

/** The markdown texts an image-url lookup scans. */
type ImageUrlTexts = readonly (string | null | undefined)[];

/** The read is bounded by the ids the texts actually reference. It runs only
 * when they name any. */
export const imageUrlsFor = async (
  texts: ImageUrlTexts,
): Promise<ImageUrls> => {
  const sources = texts.filter(
    (text): text is string => typeof text === "string",
  );
  const ids = [
    ...new Set(
      sources.flatMap((text) =>
        [...text.matchAll(/img#(\d+)/g)].map((match) => Number(match[1])),
      ),
    ),
  ];
  return ids.length === 0
    ? new Map()
    : mapById((row: { id: number; filename: string }) =>
        getImageProxyUrl(row.filename),
      )(await imageUrlColumns.many({}, { where: inList("id", ids) }));
};

/** Merge one id→URL table into the request's page-image slot, which
 * renderMarkdown's default reads. No-op outside a request, so out-of-request
 * work cannot seed a table into any later one. */
export const mergePageImageUrls = (table: ImageUrls): void =>
  withRequestStore((store) => {
    if (!store.pageImageUrls) store.pageImageUrls = new Map();
    for (const [id, url] of table) store.pageImageUrls.set(id, url);
  });

/** Run the bounded lookup for the texts' img#N references and merge the
 * result into the request's page-image slot. No request context → no-op.
 * Texts that name no image query nothing and merge nothing. */
export const addPageImageUrls = async (texts: ImageUrlTexts): Promise<void> => {
  if (!currentRequestStore()) return;
  mergePageImageUrls(await imageUrlsFor(texts));
};

/** Write the notes' img#N table into the request's page-image slot. The
 * attendees list, the listing panels, and the attendee banner all render
 * system notes. */
export const addNoteImageUrls = async (
  notes: readonly { note: string }[],
): Promise<void> => addPageImageUrls(notes.map((note) => note.note));

/** The pieces of a rendered ticket page whose markdown can name an image. */
export type TicketPageTexts = {
  listings: readonly { listing: { description: string | null } }[];
  questions: readonly { text: string }[];
  groupDescription?: string;
  terms?: string | null;
  packages: readonly { description: string }[];
};

/** Write one ticket page's img#N table into the request's page-image slot.
 * The lookup is one bounded batch over the listing descriptions, the question
 * texts, the group description, the terms, and the packages' descriptions.
 * The submit, quote, and API flows never call it. */
export const addTicketPageImageUrls = async (
  page: TicketPageTexts,
): Promise<void> =>
  mergePageImageUrls(
    await imageUrlsFor([
      ...page.listings.map((entry) => entry.listing.description),
      ...page.questions.map((question) => question.text),
      page.groupDescription,
      page.terms,
      ...page.packages.map((pkg) => pkg.description),
    ]),
  );

export const getAllImages = (): Promise<Image[]> =>
  imageColumns.many({}, { order: "id DESC" });

export const getImageById = (id: number): Promise<Image | null> =>
  imagesTable.read.one({ id });

export const imageFilenameSubquery = (
  itemType: ImageUseItemType,
  itemIdExpr: string,
  filenameColumn: "filename" | "filename_thumb" | "alt_text",
  alias: string,
): string =>
  `COALESCE((SELECT image.${filenameColumn}
      FROM image_uses AS imageUse
      JOIN images AS image ON image.id = imageUse.image_id
     WHERE imageUse.item_type = '${itemType}'
       AND imageUse.item_id = ${itemIdExpr}
     ORDER BY imageUse.sort_order ASC, imageUse.image_id ASC
     LIMIT 1), '') AS ${alias}`;

export const imageFilenameSubqueries = (
  itemType: ImageUseItemType,
  itemIdExpr: string,
): string =>
  [
    imageFilenameSubquery(itemType, itemIdExpr, "filename", "image_url"),
    imageFilenameSubquery(itemType, itemIdExpr, "alt_text", "image_alt_text"),
    imageFilenameSubquery(
      itemType,
      itemIdExpr,
      "filename_thumb",
      "image_thumb_url",
    ),
  ].join(", ");

/** The images attached to one item, in the order the operator arranged them.
 * Both image reads below want the same rows and differ only in which columns
 * they open, so they say it once here. */
const imagesOfItem = (
  columns: string,
  itemType: ImageUseItemType,
  itemId: number,
): Read => ({
  columns,
  from: "image_uses AS imageUse JOIN images AS image ON image.id = imageUse.image_id",
  order: "imageUse.sort_order ASC, imageUse.image_id ASC",
  where: imageUseTargets.where(
    imageUseTargets.of(itemType)(itemId),
    "imageUse",
  ),
});

export const getImageFilenamesForItem = async (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<ItemImageColumns> => {
  type ImageFileRow = StoredRowOf<Image, typeof imageFileColumns.columns> & {
    id: number;
  };
  const stored = await readOneRow<ImageFileRow>(
    imagesOfItem(imageFileColumns.columnsSql("image"), itemType, itemId),
  );
  if (!stored)
    return { image_alt_text: "", image_thumb_url: "", image_url: "" };
  const image = await imageFileColumns.read(
    stored,
    `${stored.id} (first image of ${itemType} ${itemId})`,
  );
  return {
    image_alt_text: image.alt_text,
    image_thumb_url: image.filename_thumb,
    image_url: image.filename,
  };
};

export const getImagesForItem = async (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<OrderedImage[]> => {
  type OrderedImageRow = StoredRowOf<Image, typeof imageColumns.columns> & {
    sort_order: number;
  };
  const rows = await readRows<OrderedImageRow>(
    imagesOfItem(
      `${imageColumns.columnsSql("image")}, imageUse.sort_order`,
      itemType,
      itemId,
    ),
  );
  const images = await imageColumns.readAll(rows);
  return images.map((image, index) => ({
    ...image,
    sort_order: rows[index]!.sort_order,
  }));
};

export const getImageUsesForImage = (imageId: number): Promise<ImageUse[]> =>
  readRows<ImageUse>({
    columns: "image_id, item_type, item_id, sort_order",
    from: "image_uses",
    order: "item_type ASC, item_id ASC",
    where: equals("image_id", imageId),
  });

const imageUseOrder = defineOrderedCollection({
  key: "image_id",
  scope: ["item_type", "item_id"] as const,
  table: "image_uses",
});

/**
 * The insert that links an image to a record, ignoring a link already there.
 * It only lands while the image and record still exist, so a stale request can
 * never leave a link to nothing.
 */
const linkImageStatement = (
  imageId: number,
  target: ImageUseTarget,
  sortOrder: number,
): SqlStatement =>
  numberedStatement((bind) => {
    const image = bind(imageId);
    const itemId = bind(target.id);
    return `INSERT OR IGNORE INTO image_uses (image_id, item_type, item_id, sort_order)
          SELECT ${image}, ${bind(target.kind)}, ${itemId}, ${bind(sortOrder)}
           WHERE EXISTS (SELECT 1 FROM images WHERE id = ${image})
             AND ${imageUseTargets.existsSql(target.kind, itemId)}`;
  });

/** Clear every image link of one record. */
export const clearImageUsesForItemStatement =
  imageUseTargets.deleteFrom("image_uses");

export const setImagesForItem = (
  itemType: ImageUseItemType,
  itemId: number,
  imageIds: readonly number[],
): Promise<void> => {
  const target = imageUseTargets.of(itemType)(itemId);
  const uniqueIds = [...new Set(imageIds)];
  return executeBatch([
    clearImageUsesForItemStatement(target),
    ...uniqueIds.map((imageId, index) =>
      linkImageStatement(imageId, target, index),
    ),
  ]);
};

export const appendImageToItem = (
  imageId: number,
  target: ImageUseTarget,
): Promise<void> =>
  useTransaction(undefined, async (transaction) => {
    const sortOrder = await imageUseOrder.next({
      scope: [target.kind, target.id],
      transaction,
    });
    await transaction.execute(linkImageStatement(imageId, target, sortOrder));
  });

/** Drop this image's links to every record other than the ones named. Naming
 *  none of them drops all of its links. */
const clearStaleImageUseTargetsStatement = (
  imageId: number,
  targets: readonly ImageUseTarget[],
): SqlStatement => {
  const kept = targets.map((target) => imageUseTargets.where(target));
  return {
    args: [
      imageId,
      ...kept.flatMap((clauses) => clauses.flatMap((clause) => clause.args)),
    ],
    sql: `DELETE FROM image_uses WHERE image_id = ?${
      kept.length === 0
        ? ""
        : ` AND NOT (${kept
            .map(
              (clauses) =>
                `(${clauses.map((clause) => clause.clause).join(" AND ")})`,
            )
            .join(" OR ")})`
    }`,
  };
};

export const setItemsForImage = (
  imageId: number,
  targets: readonly ImageUseTarget[],
): Promise<void> => {
  const unique = imageUseTargets.unique(targets);
  return useTransaction(undefined, async (transaction) => {
    const sortOrders = await imageUseOrder.nextMany({
      items: unique.map((target) => ({ scope: [target.kind, target.id] })),
      transaction,
    });
    await transaction.batch([
      clearStaleImageUseTargetsStatement(imageId, unique),
      ...unique.map((target, index) =>
        linkImageStatement(imageId, target, sortOrders[index]!),
      ),
    ]);
  });
};

export const deleteImageRecord = async (imageId: number): Promise<void> => {
  await executeBatch([
    { args: [imageId], sql: "DELETE FROM image_uses WHERE image_id = ?" },
    { args: [imageId], sql: "DELETE FROM images WHERE id = ?" },
  ]);
};
