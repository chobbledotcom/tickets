/**
 * First-class uploaded images and their ordered item links.
 */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { StoredRowOf } from "#db/chosen-columns.ts";
import {
  executeBatch,
  type SqlStatement,
  type TxScope,
  useTransaction,
} from "#db/client.ts";
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
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import { getCurrentSettingsVersion } from "#db/settings.ts";
import { type ColumnDef, col, writeTableRow } from "#db/table.ts";
import { readById } from "#db/table-reader.ts";
import { equals, inList } from "#db/where-clauses.ts";
import { lazyRef, mapById } from "#fp";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
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

const imageUrlColumns = imagesTable.read.pick(["id", "filename"]);

/** The id→uid-URL table the markdown render resolves the editor's `img#N`
 * references against. Each entry maps one referenced image's id to its
 * canonical filename URL, so no image is ever addressable by id. */
export type ImageUrls = ReadonlyMap<number, string>;

/** The markdown texts an image-url lookup scans. */
type ImageUrlTexts = readonly (string | null | undefined)[];

/** The image ids the texts name, deduplicated. A text that names no image
 * contributes nothing. */
const referencedImageIds = (texts: ImageUrlTexts): number[] => [
  ...new Set(
    texts
      .filter((text): text is string => typeof text === "string")
      .flatMap((text) =>
        [...text.matchAll(/img#(\d+)/g)]
          .map((match) => Number(match[1]))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
  ),
];

/** The per-isolate id→URL cache. The whole map is valid for one settings
 * version. Every images write bumps that version in its transaction, so a
 * write makes the next lookup drop the map. Apps live about 30 seconds, so
 * a warm entry dies before staleness matters. The version check is the only
 * staleness signal the cache needs. */
const cacheBound = 200;

const [getCache, setCache] = lazyRef<{
  urls: Map<number, string>;
  version: number;
} | null>(() => null);

registerTableInvalidation(["images"], () => {
  setCache(null);
});

/** The read is bounded by the ids the texts actually reference. Answers come
 * from the cache while its version matches. The misses share one batched
 * query, and a failed lookup fills nothing. A fill that carries the map
 * past the bound resets it, so the map never grows without limit. It runs
 * only when the texts name any image. */
export const imageUrlsFor = async (
  texts: ImageUrlTexts,
): Promise<ImageUrls> => {
  const ids = referencedImageIds(texts);
  if (ids.length === 0) return new Map();
  const version = await getCurrentSettingsVersion();
  const cache = getCache();
  const cached = cache?.version === version ? cache.urls : undefined;
  const table = new Map<number, string>();
  const missing: number[] = [];
  for (const id of ids) {
    const url = cached?.get(id);
    if (url === undefined) missing.push(id);
    else table.set(id, url);
  }
  if (missing.length === 0) return table;
  const fetched = mapById((row: { id: number; filename: string }) =>
    getImageProxyUrl(row.filename),
  )(await imageUrlColumns.many({}, { where: inList("id", missing) }));
  for (const [id, url] of fetched) table.set(id, url);
  const warm = cached ?? new Map<number, string>();
  for (const [id, url] of fetched) warm.set(id, url);
  if (warm.size > cacheBound) setCache({ urls: new Map(), version });
  else setCache({ urls: warm, version });
  return table;
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
  footer?: string | null;
  packages: readonly { description: string }[];
};

/** Write one ticket page's img#N table into the request's page-image slot.
 * The lookup is one bounded batch over the listing descriptions, the question
 * texts, the group description, the terms, the site footer, and the packages'
 * descriptions. The submit, quote, and API flows never call it. */
export const addTicketPageImageUrls = async (
  page: TicketPageTexts,
): Promise<void> =>
  addPageImageUrls([
    ...page.listings.map((entry) => entry.listing.description),
    ...page.questions.map((question) => question.text),
    page.groupDescription,
    page.terms,
    page.footer,
    ...page.packages.map((pkg) => pkg.description),
  ]);

export const getAllImages = (): Promise<Image[]> =>
  imageColumns.many({}, { order: "id DESC" });

export const getImageById = readById(imagesTable);

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

/** Run one images-row write with the shared version bump in the same
 * transaction. */
const withImageVersionBump = <T>(
  write: (transaction: TxScope) => Promise<T>,
): Promise<T> =>
  useTransaction(undefined, async (transaction) => {
    const result = await write(transaction);
    await transaction.execute(settingsVersionIncrement());
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
 * input that names no column throws here instead of failing at the
 * database. */
export const updateImageRecord = async (
  id: number,
  input: Partial<ImageInput>,
): Promise<Image | null> => {
  if (Object.keys(input).length === 0) {
    throw new Error(`Image ${id} update names no column to write`);
  }
  return withImageVersionBump((transaction) =>
    writeTableRow(transaction, imagesTable, { id, input, kind: "update" }),
  );
};

export const deleteImageRecord = async (imageId: number): Promise<void> => {
  await executeBatch([
    { args: [imageId], sql: "DELETE FROM image_uses WHERE image_id = ?" },
    { args: [imageId], sql: "DELETE FROM images WHERE id = ?" },
    // The shared version is the signal every isolate reads, so a deletion
    // here drops the cached URLs the other isolates still hold.
    settingsVersionIncrement(),
  ]);
};
