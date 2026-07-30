/**
 * First-class uploaded images and their ordered item links.
 */

/* jscpd:ignore-start */
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { StoredRowOf } from "#shared/db/chosen-columns.ts";
import {
  executeBatch,
  type SqlStatement,
  useTransaction,
} from "#shared/db/client.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { defineOrderedCollection } from "#shared/db/ordered-collection.ts";
import { type Read, readOneRow, readRows } from "#shared/db/read.ts";
import { type ColumnDef, col } from "#shared/db/table.ts";
import { equals } from "#shared/db/where-clauses.ts";
import { decryptImageFilename } from "#shared/images/broken.ts";
import type {
  Image,
  ImageUse,
  ImageUseItemType,
  ItemImageColumns,
} from "#shared/types.ts";
import type { NonEmptyString } from "#shared/validation/string.ts";
/* jscpd:ignore-end */

export type ImageInput = {
  name: string;
  filename: NonEmptyString;
  filenameThumb: NonEmptyString;
  altText?: string | undefined;
};

export type ImageUseTarget = {
  itemType: ImageUseItemType;
  itemId: number;
};

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

const imageFileColumns = imagesTable.read.pick([
  "id",
  "filename",
  "filename_thumb",
  "alt_text",
]);

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
  where: [
    ...equals("imageUse.item_type", itemType),
    ...equals("imageUse.item_id", itemId),
  ],
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

const itemTable: Record<ImageUseItemType, string> = {
  group: "groups",
  listing: "listings",
  news: "news_posts",
  page: "site_pages",
};

const imageUseOrder = defineOrderedCollection({
  key: "image_id",
  scope: ["item_type", "item_id"] as const,
  table: "image_uses",
});

const imageUseInsertStatement = (
  imageId: number,
  itemType: ImageUseItemType,
  itemId: number,
  sortOrder: number,
): SqlStatement => ({
  args: [imageId, itemType, itemId, sortOrder, imageId],
  sql: `INSERT OR IGNORE INTO image_uses (image_id, item_type, item_id, sort_order)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM images WHERE id = ?)`,
});

export const setImagesForItem = (
  itemType: ImageUseItemType,
  itemId: number,
  imageIds: readonly number[],
): Promise<void> => {
  const uniqueIds = [...new Set(imageIds)];
  return executeBatch([
    {
      args: [itemType, itemId],
      sql: "DELETE FROM image_uses WHERE item_type = ? AND item_id = ?",
    },
    ...uniqueIds.map((imageId, index) =>
      imageUseInsertStatement(imageId, itemType, itemId, index),
    ),
  ]);
};

const attachImageToExistingItemStatement = (
  imageId: number,
  target: ImageUseTarget,
  sortOrder: number,
): SqlStatement => {
  const table = itemTable[target.itemType];
  return {
    args: [
      imageId,
      target.itemType,
      target.itemId,
      sortOrder,
      imageId,
      target.itemId,
    ],
    sql: `INSERT OR IGNORE INTO image_uses (image_id, item_type, item_id, sort_order)
          SELECT ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM images WHERE id = ?)
             AND EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
  };
};

export const appendImageToItem = (
  imageId: number,
  target: ImageUseTarget,
): Promise<void> =>
  useTransaction(undefined, async (transaction) => {
    const sortOrder = await imageUseOrder.next({
      scope: [target.itemType, target.itemId],
      transaction,
    });
    await transaction.execute(
      attachImageToExistingItemStatement(imageId, target, sortOrder),
    );
  });

const clearStaleImageUseTargetsStatement = (
  imageId: number,
  targets: readonly ImageUseTarget[],
): SqlStatement => {
  const targetPredicates = targets.map(() => "(item_type = ? AND item_id = ?)");
  return {
    args: [
      imageId,
      ...targets.flatMap((target) => [target.itemType, target.itemId]),
    ],
    sql: `DELETE FROM image_uses WHERE image_id = ?${
      targetPredicates.length === 0
        ? ""
        : ` AND NOT (${targetPredicates.join(" OR ")})`
    }`,
  };
};

export const setItemsForImage = (
  imageId: number,
  targets: readonly ImageUseTarget[],
): Promise<void> => {
  const unique = [
    ...new Map(
      targets.map((target) => [`${target.itemType}:${target.itemId}`, target]),
    ).values(),
  ];
  return useTransaction(undefined, async (transaction) => {
    const sortOrders = await imageUseOrder.nextMany({
      items: unique.map((target) => ({
        scope: [target.itemType, target.itemId],
      })),
      transaction,
    });
    await transaction.batch([
      clearStaleImageUseTargetsStatement(imageId, unique),
      ...unique.map((target, index) =>
        attachImageToExistingItemStatement(imageId, target, sortOrders[index]!),
      ),
    ]);
  });
};

/**
 * A statement builder that deletes every row of `table` matching one
 * (item_type, item_id) pair. The callers differ only in the table and the
 * item-type they accept. `table` must be a trusted constant, never input.
 */
export const deleteByItemStatement =
  <ItemType extends string>(table: string) =>
  (itemType: ItemType, itemId: number): SqlStatement => ({
    args: [itemType, itemId],
    sql: `DELETE FROM ${table} WHERE item_type = ? AND item_id = ?`,
  });

export const clearImageUsesForItemStatement =
  deleteByItemStatement<ImageUseItemType>("image_uses");

export const deleteImageRecord = async (imageId: number): Promise<void> => {
  await executeBatch([
    { args: [imageId], sql: "DELETE FROM image_uses WHERE image_id = ?" },
    { args: [imageId], sql: "DELETE FROM images WHERE id = ?" },
  ]);
};
