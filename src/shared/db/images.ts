/**
 * First-class uploaded images and their ordered item links.
 */

import { mapParallel } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  executeBatch,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { type ColumnDef, col } from "#shared/db/table.ts";
import { decryptImageFilename } from "#shared/images/broken.ts";
import type {
  Image,
  ImageUse,
  ImageUseItemType,
  ItemImageProjection,
} from "#shared/types.ts";
import type { NonEmptyString } from "#shared/validation/string.ts";

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

const IMAGE_COLUMNS = "id, name, filename, filename_thumb, alt_text";

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

const fromDbImages = (rows: Image[]): Promise<Image[]> =>
  mapParallel(imagesTable.fromDb)(rows);

export const getAllImages = async (): Promise<Image[]> =>
  fromDbImages(
    await queryAll<Image>(
      `SELECT ${IMAGE_COLUMNS} FROM images ORDER BY id DESC`,
    ),
  );

export const getImageById = (id: number): Promise<Image | null> =>
  imagesTable.findById(id);

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

export const getImageFilenamesForItem = async (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<ItemImageProjection> => {
  const rows = await queryAll<{
    alt_text: EnvKeyEncrypted | "";
    filename: EnvKeyEncrypted;
    filename_thumb: EnvKeyEncrypted;
    id: number;
  }>(
    `SELECT image.id, image.filename, image.filename_thumb, image.alt_text
       FROM image_uses AS imageUse
       JOIN images AS image ON image.id = imageUse.image_id
      WHERE imageUse.item_type = ? AND imageUse.item_id = ?
      ORDER BY imageUse.sort_order ASC, imageUse.image_id ASC
      LIMIT 1`,
    [itemType, itemId],
  );
  const row = rows[0];
  if (!row) return { image_alt_text: "", image_thumb_url: "", image_url: "" };
  const imageRef = `image ${row.id} (first image of ${itemType} ${itemId})`;
  return {
    image_alt_text: row.alt_text === "" ? "" : await decrypt(row.alt_text),
    image_thumb_url: await decryptImageFilename(
      row.filename_thumb,
      `${imageRef} thumbnail filename`,
    ),
    image_url: await decryptImageFilename(row.filename, `${imageRef} filename`),
  };
};

export const getImagesForItem = async (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<OrderedImage[]> => {
  const rows = await queryAll<Image & { sort_order: number }>(
    `SELECT image.${IMAGE_COLUMNS.replaceAll(", ", ", image.")},
            imageUse.sort_order
       FROM image_uses AS imageUse
       JOIN images AS image ON image.id = imageUse.image_id
      WHERE imageUse.item_type = ? AND imageUse.item_id = ?
      ORDER BY imageUse.sort_order ASC, imageUse.image_id ASC`,
    [itemType, itemId],
  );
  const images = await fromDbImages(rows);
  return images.map((image, index) => ({
    ...image,
    sort_order: rows[index]!.sort_order,
  }));
};

export const getImageUsesForImage = (imageId: number): Promise<ImageUse[]> =>
  queryAll<ImageUse>(
    `SELECT image_id, item_type, item_id, sort_order
       FROM image_uses
      WHERE image_id = ?
      ORDER BY item_type ASC, item_id ASC`,
    [imageId],
  );

const itemTable: Record<ImageUseItemType, string> = {
  group: "groups",
  listing: "listings",
  news: "news_posts",
  page: "site_pages",
};

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
): SqlStatement => {
  const table = itemTable[target.itemType];
  return {
    args: [
      imageId,
      target.itemType,
      target.itemId,
      target.itemType,
      target.itemId,
      imageId,
      target.itemId,
    ],
    sql: `INSERT OR IGNORE INTO image_uses (image_id, item_type, item_id, sort_order)
          SELECT ?, ?, ?,
                 COALESCE((SELECT MAX(sort_order) + 1 FROM image_uses
                            WHERE item_type = ? AND item_id = ?), 0)
           WHERE EXISTS (SELECT 1 FROM images WHERE id = ?)
             AND EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
  };
};

export const appendImageToItem = (
  imageId: number,
  target: ImageUseTarget,
): Promise<void> =>
  executeBatch([attachImageToExistingItemStatement(imageId, target)]);

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
  return executeBatch([
    clearStaleImageUseTargetsStatement(imageId, unique),
    ...unique.map((target) =>
      attachImageToExistingItemStatement(imageId, target),
    ),
  ]);
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
