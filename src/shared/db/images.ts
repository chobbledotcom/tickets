/**
 * First-class uploaded images and their ordered item links.
 */

import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { removalWithChildren, targetRowsRemoval } from "#db/child-rows.ts";
import {
  executeBatch,
  resultRows,
  type TxScope,
  useTransaction,
} from "#db/client.ts";
import { defineOrderedCollection } from "#db/ordered-collection.ts";
import { columnsNamed, pickedColumns } from "#db/picked-columns.ts";
import { readOneRow, readRows } from "#db/read.ts";

import { allRowsNewestFirst, records, rowValuesOf } from "#db/record-table.ts";
import {
  defineRecordTarget,
  ITEM_TARGET_COLUMNS,
  type RecordTarget,
  type RecordTargets,
} from "#db/record-target.ts";
import { onReplicaAndPrimary } from "#db/replica-or-primary.ts";
import {
  among,
  and,
  type Expr,
  equal,
  not,
  or,
  valued,
  wholeCondition,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import { type SqlStatement, sql, sqlLiteral, sqlName } from "#db/sql.ts";
import { txIdSetInTable } from "#db/transaction.ts";
import { deleteFrom, insertInto } from "#db/write.ts";
import { groupToMap, unique } from "#fp";
import { decryptImageFilenameOrEmpty } from "#shared/images/broken.ts";
import { requireValue } from "#shared/required-value.ts";
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

export type OrderedImage = Image & { sortOrder: number };

/** Every image, newest first. */
export const getAllImages = allRowsNewestFirst(tables.images);

/** The first image of an item as a read projects it: sealed, or "" when the
 *  item has no image. */
export type SealedItemImages = {
  readonly [Value in keyof ItemImageColumns]: EnvKeyEncrypted | "";
};

/** One column of the first image of an item, or "" when it has none. */
const firstImageValue = (
  itemType: ImageUseItemType,
  itemIdExpr: SqlStatement,
  column: "alt_text" | "filename" | "filename_thumb",
): Expr<EnvKeyEncrypted | ""> =>
  valued(sql`COALESCE((SELECT ${sqlName(`image.${column}`)}
      FROM image_uses AS imageUse
      JOIN images AS image ON image.id = imageUse.image_id
     WHERE imageUse.item_type = ${sqlLiteral(itemType)}
       AND imageUse.item_id = ${itemIdExpr}
     ORDER BY imageUse.sort_order ASC, imageUse.image_id ASC
     LIMIT 1), '')`);

/** The sealed first-image values of an item, for a builder select. Open them
 *  with {@link openItemImages}. */
export const itemImageValues = (
  itemType: ImageUseItemType,
  itemIdExpr: SqlStatement,
): { [Value in keyof ItemImageColumns]: Expr<EnvKeyEncrypted | ""> } => ({
  imageAltText: firstImageValue(itemType, itemIdExpr, "alt_text"),
  imageThumbUrl: firstImageValue(itemType, itemIdExpr, "filename_thumb"),
  imageUrl: firstImageValue(itemType, itemIdExpr, "filename"),
});

/** The same values as a column list for a read written by hand. */
export const imageFilenameSubqueries = (
  itemType: ImageUseItemType,
  itemIdExpr: SqlStatement,
): SqlStatement => pickedColumns(itemImageValues(itemType, itemIdExpr)).list;

/** Open the projected first-image values of an item. A filename that will not
 *  open reads as the broken-image marker. */
export const openItemImages = async (
  sealed: SealedItemImages,
  source: string,
): Promise<ItemImageColumns> => ({
  imageAltText:
    sealed.imageAltText === "" ? "" : await decrypt(sealed.imageAltText),
  imageThumbUrl: await decryptImageFilenameOrEmpty(
    sealed.imageThumbUrl,
    `${source} thumbnail image`,
  ),
  imageUrl: await decryptImageFilenameOrEmpty(
    sealed.imageUrl,
    `${source} image`,
  ),
});

/** The id and the files of an image, for a read that names its own columns. */
const imageFileColumns = columnsNamed([
  "altText",
  "filename",
  "filenameThumb",
  "id",
]);

/** The images attached to one item, in the order the operator arranged them.
 * Both image reads below want the same rows and differ only in which columns
 * they open, so they say it once here. */
const imagesOfItem = (itemType: ImageUseItemType, itemId: number) =>
  from(tables.image_uses, { image: {} })
    .where(() =>
      imageUseTargets.where(imageUseTargets.of(itemType)(itemId), "imageUse"),
    )
    .orderBy((use) => [use.sortOrder, use.imageId]);

export const getImageFilenamesForItem = async (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<ItemImageColumns> => {
  const image = await readOneRow(
    imagesOfItem(itemType, itemId)
      .limit(1)
      .select((use) => imageFileColumns(use.image)),
  );
  if (!image) return { imageAltText: "", imageThumbUrl: "", imageUrl: "" };
  return {
    imageAltText: image.altText,
    imageThumbUrl: image.filenameThumb,
    imageUrl: image.filename,
  };
};

export const getImagesForItem = (
  itemType: ImageUseItemType,
  itemId: number,
): Promise<OrderedImage[]> =>
  readRows(
    imagesOfItem(itemType, itemId).select((use) => ({
      ...imageFileColumns(use.image),
      name: use.image.name,
      sortOrder: use.sortOrder,
    })),
  );

/** The columns of one link between an image and a record. */
const imageUseColumns = columnsNamed([
  "imageId",
  "itemId",
  "itemType",
  "sortOrder",
]);

/** The item links of several images, keyed by image id. One query covers the
 *  whole list. An image with no links has no entry. The links of one image
 *  stay in the order the image's own read answers them. */
export const getImageUsesForImages = async (
  imageIds: readonly number[],
): Promise<Map<number, ImageUse[]>> => {
  if (imageIds.length === 0) return new Map();
  const rows = await readRows(
    from(tables.image_uses)
      .where((use) => among(use.imageId, imageIds))
      .orderBy((use) => [use.imageId, use.itemType, use.itemId])
      .select(imageUseColumns),
  );
  return groupToMap(
    (use: ImageUse) => use.imageId,
    (use: ImageUse) => use,
  )(rows);
};

/** The links of one image. The primary version answers a write that just
 *  committed them, so a lagging replica cannot answer with the links that it
 *  replaced. */
export const {
  onPrimary: getImageUsesForImageOnPrimary,
  onReplica: getImageUsesForImage,
} = onReplicaAndPrimary(
  (imageId: number) =>
    from(tables.image_uses)
      .where((use) => equal(use.imageId, imageId))
      .orderBy((use) => [use.itemType, use.itemId])
      .select(imageUseColumns),
  (uses): ImageUse[] => uses,
);

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
      imageId,
      itemId: target.id,
      itemType: target.kind,
      sortOrder,
    },
    {
      or: "IGNORE",
      when: and(
        records.images.byId(imageId).exists(),
        wholeCondition(imageUseTargets.existsSql(target.kind, target.id)),
      ),
    },
  );

/** Clear every image link of one record. */
export const clearImageUsesForItemStatement = targetRowsRemoval(
  tables.image_uses,
  imageUseTargets,
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
    equal(use.imageId, imageId),
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

/** The insert of one image record, on an open transaction. */
const insertImage = async (
  transaction: TxScope,
  input: ImageInput,
): Promise<Image> => {
  const [image] = resultRows(
    await transaction.execute(
      await records.images.insertStatement({
        altText: input.altText ?? "",
        filename: input.filename,
        filenameThumb: input.filenameThumb,
        name: input.name,
      }),
    ),
  );
  return requireValue(image, "The image insert gave back no row");
};

/** Insert one image record. The insert is unconditional, so the written row
 * always comes back. */
export const insertImageRecord = async (input: ImageInput): Promise<Image> =>
  withImageVersionBump((transaction) => insertImage(transaction, input));

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
    async (tx) =>
      resultRows(
        await tx.execute(
          await records.images.updateStatement(
            id,
            rowValuesOf(tables.images, input),
          ),
        ),
      )[0] ?? null,
    transaction,
  );
};

const imageRemoval = removalWithChildren(tables.images, [
  [tables.image_uses, "image_id"],
]);

export const deleteImageRecord = async (imageId: number): Promise<void> => {
  await executeBatch([
    ...imageRemoval(imageId),
    // The shared version is the signal every isolate reads, so a deletion
    // here drops the cached URLs the other isolates still hold.
    settingsVersionIncrement(),
  ]);
};
