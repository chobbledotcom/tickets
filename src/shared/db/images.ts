/**
 * First-class uploaded images and their ordered item links.
 */

import type { InValue } from "@libsql/client";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { StoredRowOf } from "#db/chosen-columns.ts";
import {
  executeBatch,
  queryAllPrimary,
  type TxScope,
  useTransaction,
} from "#db/client.ts";
import { defineIdTable } from "#db/define-id-table.ts";
import { defineOrderedCollection } from "#db/ordered-collection.ts";
import { readOneRow, readRows } from "#db/read.ts";
import {
  defineRecordTarget,
  ITEM_TARGET_COLUMNS,
  type RecordTarget,
  type RecordTargets,
} from "#db/record-target.ts";
import {
  among,
  and,
  equal,
  not,
  or,
  wholeCondition,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import {
  type SqlStatement,
  sql,
  sqlCommas,
  sqlLiteral,
  sqlName,
} from "#db/sql.ts";
import { type ColumnDef, col, writeTableRow } from "#db/table.ts";
import { readById } from "#db/table-reader.ts";
import { txIdSetInTable } from "#db/transaction.ts";
import { deleteFrom, insertInto } from "#db/write.ts";
import { groupToMap, unique } from "#fp";
import { decryptImageFilename } from "#shared/images/broken.ts";
import type { NonEmptyString } from "#shared/validation/string.ts";
import {
  type Image,
  type ImageUse,
  type ImageUseItemType,
  ImageUseItemTypeSchema,
  type ItemImageColumns,
} from "#types";

export type ImageInput = {
  name: string;
  filename: NonEmptyString;
  filenameThumb: NonEmptyString;
  altText?: string | undefined;
};

/** One record an image can be attached to. */
export type ImageUseTarget = RecordTarget<ImageUseItemType>;

/** The table each kind of record images hang off lives in. */
export const imageUseTables: Readonly<Record<ImageUseItemType, string>> = {
  group: "groups",
  listing: "listings",
  news: "news_posts",
  page: "site_pages",
};

/** How to name and ask for the records images hang off. Each kind lists its
 * table so an attach can insist the record is really there. */
export const imageUseTargets: RecordTargets<ImageUseItemType> =
  defineRecordTarget({
    columns: ITEM_TARGET_COLUMNS,
    kinds: ImageUseItemTypeSchema.options,
    tables: imageUseTables,
  });

export type OrderedImage = Image & { sort_order: number };

/** Encrypted filename column: sealed on write. On read, a value that will not
 * decrypt to a real filename becomes the broken-image marker. It is reported,
 * never thrown. One broken record must not take down every page that lists
 * images. The `as` cast is the same sanctioned read boundary as col.encrypted. */
const encryptedFilenameText = (label: string): ColumnDef<NonEmptyString> =>
  col.converted<NonEmptyString>({
    read: (raw: InValue, rowId?: unknown) =>
      decryptImageFilename(raw as string, `image ${String(rowId)} ${label}`),
    write: (value: NonEmptyString) => encrypt(value),
  });

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

export const getAllImages = imageColumns.every({ order: sql`id DESC` });

export const getImageById = readById(imagesTable);

export const imageFilenameSubquery = (
  itemType: ImageUseItemType,
  itemIdExpr: SqlStatement,
  filenameColumn: "filename" | "filename_thumb" | "alt_text",
  alias: string,
): SqlStatement =>
  sql`COALESCE((SELECT ${sqlName(`image.${filenameColumn}`)}
      FROM image_uses AS imageUse
      JOIN images AS image ON image.id = imageUse.image_id
     WHERE imageUse.item_type = ${sqlLiteral(itemType)}
       AND imageUse.item_id = ${itemIdExpr}
     ORDER BY imageUse.sort_order ASC, imageUse.image_id ASC
     LIMIT 1), '') AS ${sqlName(alias)}`;

export const imageFilenameSubqueries = (
  itemType: ImageUseItemType,
  itemIdExpr: SqlStatement,
): SqlStatement =>
  sqlCommas([
    imageFilenameSubquery(itemType, itemIdExpr, "filename", "image_url"),
    imageFilenameSubquery(itemType, itemIdExpr, "alt_text", "image_alt_text"),
    imageFilenameSubquery(
      itemType,
      itemIdExpr,
      "filename_thumb",
      "image_thumb_url",
    ),
  ]);

/** The images attached to one item, in the order the operator arranged them.
 * Both image reads below want the same rows and differ only in which columns
 * they open, so they say it once here. */
const imagesOfItem = (
  columns: SqlStatement,
  itemType: ImageUseItemType,
  itemId: number,
  limit?: number,
): SqlStatement => {
  const ordered = from(tables.image_uses, { image: {} })
    .where(() =>
      imageUseTargets.where(imageUseTargets.of(itemType)(itemId), "imageUse"),
    )
    .orderBy((use) => [use.sort_order, use.image_id]);
  return (limit === undefined ? ordered : ordered.limit(limit)).columns(
    () => columns,
  );
};

export const getImageFilenamesForItem = async (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<ItemImageColumns> => {
  type ImageFileRow = StoredRowOf<Image, typeof imageFileColumns.columns> & {
    id: number;
  };
  const stored = await readOneRow<ImageFileRow>(
    imagesOfItem(imageFileColumns.columnsSql("image"), itemType, itemId, 1),
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
      sql`${imageColumns.columnsSql("image")}, imageUse.sort_order`,
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

/** The columns of one link between an image and a record. */
const imageUseColumns = (use: Node<"image_uses">) => ({
  image_id: use.image_id,
  item_id: use.item_id,
  item_type: use.item_type,
  sort_order: use.sort_order,
});

/** The item links of several images, keyed by image id. One query covers the
 *  whole list. An image with no links has no entry. The links of one image
 *  stay in the order the image's own read answers them. */
export const getImageUsesForImages = async (
  imageIds: readonly number[],
): Promise<Map<number, ImageUse[]>> => {
  if (imageIds.length === 0) return new Map();
  const rows = await readRows(
    from(tables.image_uses)
      .where((use) => among(use.image_id, imageIds))
      .orderBy((use) => [use.image_id, use.item_type, use.item_id])
      .select(imageUseColumns),
  );
  return groupToMap(
    (use: ImageUse) => use.image_id,
    (use: ImageUse) => use,
  )(rows);
};

/** One image's links, on the replica (normal reads) or the primary (the
 *  answer to a write that just committed them). */
const imageUsesForImage =
  (primary: boolean) =>
  (imageId: number): Promise<ImageUse[]> => {
    const read = from(tables.image_uses)
      .where((use) => equal(use.image_id, imageId))
      .orderBy((use) => [use.item_type, use.item_id])
      .select(imageUseColumns);
    return primary ? queryAllPrimary<ImageUse>(read) : readRows<ImageUse>(read);
  };

export const getImageUsesForImage = imageUsesForImage(false);

/** The same links from the primary, so a lagging replica cannot answer a
 *  write with the links it replaced. */
export const getImageUsesForImageOnPrimary = imageUsesForImage(true);

/** The links a write submits that name no stored record of their kind. The
 *  check runs inside the write's transaction, so a record deleted between the
 *  parse and the write cannot leave a link to nothing. */
export const missingImageUseTargets = async (
  tx: TxScope,
  targets: readonly ImageUseTarget[],
): Promise<ImageUseTarget[]> => {
  const found = new Map<ImageUseItemType, Set<number>>();
  for (const kind of unique(targets.map((target) => target.kind))) {
    const ids = targets
      .filter((target) => target.kind === kind)
      .map((target) => target.id);
    found.set(kind, await txIdSetInTable(imageUseTables[kind])(tx, ids));
  }
  return targets.filter((target) => !found.get(target.kind)!.has(target.id));
};

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
  insertInto(
    tables.image_uses,
    {
      image_id: imageId,
      item_id: target.id,
      item_type: target.kind,
      sort_order: sortOrder,
    },
    {
      or: "IGNORE",
      when: and(
        from(tables.images).where({ id: imageId }).exists(),
        wholeCondition(imageUseTargets.existsSql(target.kind, target.id)),
      ),
    },
  );

/** Clear every image link of one record. */
export const clearImageUsesForItemStatement = imageUseTargets.deleteFrom(
  tables.image_uses,
);

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
  const kept = targets.map((target) => and(...imageUseTargets.where(target)));
  return deleteFrom(tables.image_uses).where((use) => [
    equal(use.image_id, imageId),
    kept.length === 0 ? true : not(or(...kept)),
  ]);
};

/** Set one image's links to exactly the records named. Naming none of them
 *  drops all of its links. Pass an open transaction so the row write and the
 *  links commit together. */
export const setItemsForImage = (
  imageId: number,
  targets: readonly ImageUseTarget[],
  transaction?: TxScope,
): Promise<void> => {
  const uniqueTargets = imageUseTargets.unique(targets);
  return useTransaction(transaction, async (tx) => {
    const sortOrders = await imageUseOrder.nextMany({
      items: uniqueTargets.map((target) => ({
        scope: [target.kind, target.id],
      })),
      transaction: tx,
    });
    await tx.batch([
      clearStaleImageUseTargetsStatement(imageId, uniqueTargets),
      ...uniqueTargets.map((target, index) =>
        linkImageStatement(imageId, target, sortOrders[index]!),
      ),
    ]);
  });
};

/** Run one images-row write with the shared version bump in the same
 * transaction. */
const withImageVersionBump = <T>(
  write: (transaction: TxScope) => Promise<T>,
  transaction?: TxScope,
): Promise<T> =>
  useTransaction(transaction, async (tx) => {
    const result = await write(tx);
    await tx.execute(settingsVersionIncrement());
    return result;
  });

/** Insert one image record. The insert is unconditional, so the written row
 * always comes back. */
export const insertImageRecord = async (input: ImageInput): Promise<Image> =>
  withImageVersionBump((transaction) =>
    writeTableRow(transaction, imagesTable, { input, kind: "insert" }),
  );

/** Update one image record's metadata. Returns null when the id names no
 * row. The update takes its SET clause from the provided columns alone. An
 * input with no defined value names no column to write: it throws here
 * instead of wiping a stored field or failing at the database. Pass an open
 * transaction so the row and its links commit together. */
export const updateImageRecord = async (
  id: number,
  input: Partial<ImageInput>,
  transaction?: TxScope,
): Promise<Image | null> => {
  if (Object.values(input).every((value) => value === undefined)) {
    throw new Error(`Image ${id} update names no column to write`);
  }
  return withImageVersionBump(
    (tx) => writeTableRow(tx, imagesTable, { id, input, kind: "update" }),
    transaction,
  );
};

export const deleteImageRecord = async (imageId: number): Promise<void> => {
  await executeBatch([
    deleteFrom(tables.image_uses).where({ image_id: imageId }),
    deleteFrom(tables.images).where({ id: imageId }),
    // The shared version is the signal every isolate reads, so a deletion
    // here drops the cached URLs the other isolates still hold.
    settingsVersionIncrement(),
  ]);
};
