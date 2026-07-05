/**
 * First-class uploaded images and their ordered item links.
 */

import type { InValue } from "@libsql/client";
import { mapParallel } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { executeBatch, queryAll } from "#shared/db/client.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { col } from "#shared/db/table.ts";
import type { Image, ImageUse, ImageUseItemType } from "#shared/types.ts";

export type ImageInput = {
  name: string;
  filename: string;
  filenameThumb: string;
  altText?: string | undefined;
};

export type ImageUseTarget = {
  itemType: ImageUseItemType;
  itemId: number;
};

export type OrderedImage = Image & { sort_order: number };

const IMAGE_COLUMNS = "id, name, filename, filename_thumb, alt_text";

export const imagesTable = defineIdTable<Image, ImageInput>("images", {
  alt_text: col.encryptedText(encrypt, decrypt),
  filename: col.encryptedText(encrypt, decrypt),
  filename_thumb: col.encryptedText(encrypt, decrypt),
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
  filenameColumn: "filename" | "filename_thumb",
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
    imageFilenameSubquery(
      itemType,
      itemIdExpr,
      "filename_thumb",
      "image_thumb_url",
    ),
  ].join(", ");

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

type ImageUseStatement = { sql: string; args: InValue[] };

const itemTable: Record<ImageUseItemType, string> = {
  group: "groups",
  listing: "listings",
};

const imageUseInsertStatement = (
  imageId: number,
  itemType: ImageUseItemType,
  itemId: number,
  sortOrder: number,
): ImageUseStatement => ({
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
): ImageUseStatement => {
  const table = itemTable[target.itemType];
  return {
    args: [
      imageId,
      target.itemType,
      target.itemId,
      target.itemType,
      target.itemId,
      target.itemId,
    ],
    sql: `INSERT OR IGNORE INTO image_uses (image_id, item_type, item_id, sort_order)
          SELECT ?, ?, ?,
                 COALESCE((SELECT MAX(sort_order) + 1 FROM image_uses
                            WHERE item_type = ? AND item_id = ?), 0)
           WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
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
    { args: [imageId], sql: "DELETE FROM image_uses WHERE image_id = ?" },
    ...unique.map((target) =>
      attachImageToExistingItemStatement(imageId, target),
    ),
  ]);
};

export const clearImageUsesForItemStatement = (
  itemType: ImageUseItemType,
  itemId: number,
): ImageUseStatement => ({
  args: [itemType, itemId],
  sql: "DELETE FROM image_uses WHERE item_type = ? AND item_id = ?",
});

export const deleteImageRecord = async (imageId: number): Promise<void> => {
  await executeBatch([
    { args: [imageId], sql: "DELETE FROM image_uses WHERE image_id = ?" },
    { args: [imageId], sql: "DELETE FROM images WHERE id = ?" },
  ]);
};
