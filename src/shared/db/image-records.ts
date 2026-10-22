/**
 * The image record writes: insert, update, and delete. Each write advances
 * the shared settings version, so every isolate drops its memoised footer
 * table after the change.
 */

import { executeBatch, type TxScope, useTransaction } from "#db/client.ts";
import { type ImageInput, imagesTable } from "#db/images.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import { writeTableRow } from "#db/table.ts";
import type { Image } from "#types";

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

/** Insert one image record. The insert returns the row it wrote. A write
 * that returns no row means nothing was written, and that fails here
 * loudly. */
export const insertImageRecord = async (input: ImageInput): Promise<Image> => {
  const row = await withImageVersionBump((transaction) =>
    writeTableRow(transaction, imagesTable, { input, kind: "insert" }),
  );
  if (row === null) throw new Error("Image insert returned no row");
  return row;
};

/** Update one image record's metadata. Returns null when the id names no
 * row. */
export const updateImageRecord = (
  id: number,
  input: Partial<ImageInput>,
): Promise<Image | null> =>
  withImageVersionBump((transaction) =>
    writeTableRow(transaction, imagesTable, { id, input, kind: "update" }),
  );

export const deleteImageRecord = async (imageId: number): Promise<void> => {
  await executeBatch([
    { args: [imageId], sql: "DELETE FROM image_uses WHERE image_id = ?" },
    { args: [imageId], sql: "DELETE FROM images WHERE id = ?" },
    // The shared version is the signal every isolate reads, so a deletion on
    // this isolate drops the footer table the other isolates still hold.
    settingsVersionIncrement(),
  ]);
};
