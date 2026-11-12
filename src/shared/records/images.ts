/**
 * The image record: its table, its one write rule, its upload boundary, and
 * its admin surface. The JSON API reads this declaration. The image pages stay
 * hand-wired because an upload form and a base64 body differ at the door.
 */

import { type TxScope, withTransaction } from "#db/client.ts";
import {
  deleteImageRecord,
  getAllImages,
  getImageById,
  type ImageInput,
  type ImageUseTarget,
  imagesTable,
  imageUseTargets,
  insertImageRecord,
  missingImageUseTargets,
  setItemsForImage,
  updateImageRecord,
} from "#db/images.ts";
import { refuseTheWriteOn } from "#db/transaction.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { logImageAction } from "#shared/images/activity.ts";
import { byNameThenUpload } from "#shared/images/library.ts";
import {
  FULL_IMAGE_TARGET,
  THUMB_IMAGE_TARGET,
} from "#shared/images/targets.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { sortByName } from "#shared/name-order.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { WriteVerdict } from "#shared/rest/record.ts";
import { deleteAndLog } from "#shared/rest/record-command.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  uploadImageTargets,
  validateImage,
} from "#shared/storage.ts";
import { tryDeleteFile } from "#shared/storage-cleanup.ts";
import {
  type NonEmptyString,
  nonEmptyString,
} from "#shared/validation/string.ts";
import type { Image } from "#types";

/** The name and alt text one image record carries. */
export type ImageMetadata = {
  name: string;
  altText: string;
};

/** The file bytes a new image is made from, and the type its uploader
 *  declared. */
export type ImageFile = {
  bytes: Uint8Array;
  contentType: string;
};

/** The name and alt text a write carries, checked by the rules both surfaces
 *  share. A name is required. The rendered inputs' length caps hold for a
 *  crafted request too. */
export const imageMetadata = (
  submittedName: string,
  submittedAltText: string,
): Result<ImageMetadata> => {
  const name = submittedName.trim();
  if (name === "") return errorResult(t("images.error.name_required"));
  const altText = submittedAltText.trim();
  // The rendered inputs cap length in the browser, but a crafted POST skips
  // the browser, so the parser carries the same limit for both fields.
  const overLong = [
    { label: t("images.field.name"), value: name },
    { label: t("images.field.alt_text"), value: altText },
  ].find((field) => field.value.length > MAX_INPUT_LENGTH);
  if (overLong) {
    return errorResult(
      t("fields.validation.max_length", {
        label: overLong.label,
        max: MAX_INPUT_LENGTH,
      }),
    );
  }
  return okResult({ altText, name });
};

/** Store one file pair and answer the names it wrote. */
export const uploadImageFiles = async (
  file: ImageFile,
): Promise<
  Result<{ filename: NonEmptyString; filenameThumb: NonEmptyString }>
> => {
  if (!isStorageEnabled()) {
    return errorResult(t("images.storage_off"));
  }
  const validation = validateImage(file.bytes, file.contentType);
  if (!validation.valid) {
    return errorResult(IMAGE_ERROR_MESSAGES[validation.error]);
  }
  try {
    const [filename, filenameThumb] = await uploadImageTargets(
      file.bytes,
      validation.detectedType,
      [FULL_IMAGE_TARGET, THUMB_IMAGE_TARGET],
    );
    return okResult({
      filename: nonEmptyString(filename as string, "image filename"),
      filenameThumb: nonEmptyString(
        filenameThumb as string,
        "image thumbnail filename",
      ),
    });
  } catch (err) {
    const detail = `Image upload failed: ${String(err)}`;
    logError({ code: ErrorCode.STORAGE_UPLOAD, detail });
    return errorResult(detail);
  }
};

/** Insert one image whose files are already uploaded. A failed insert removes
 *  the files it names, so no upload is left without a library entry. */
export const insertUploadedImage = async (
  input: ImageInput,
): Promise<Image> => {
  try {
    return await insertImageRecord(input);
  } catch (err) {
    await tryDeleteFile(
      input.filename,
      undefined,
      "failed image record cleanup",
    );
    await tryDeleteFile(
      input.filenameThumb,
      undefined,
      "failed image thumbnail record cleanup",
    );
    throw err;
  }
};

/** What one image write carries: the stored metadata and the links an update
 *  replaces. A null link list keeps the stored links. The list is absent on
 *  create. */
export type ImageWriteInput = ImageInput & {
  items?: ImageUseTarget[] | null;
};

/** The one image rule: the name and alt text both doors answer with. */
const imageRule = (input: ImageWriteInput): Result<ImageWriteInput> => {
  const metadata = imageMetadata(input.name, input.altText ?? "");
  if (!metadata.ok) return errorResult(metadata.error);
  return okResult({
    ...input,
    altText: metadata.value.altText,
    name: metadata.value.name,
  });
};

/** What one update's transaction answers: the row it wrote, a row deleted
 *  before the commit, or the link conflict. */
type UpdateTxOutcome =
  | { conflict: string }
  | { notFound: true }
  | { row: Image };

/** The row write and its links commit together. A link that names no stored
 *  record refuses the whole write, so the image keeps its links. */
const updateInTransaction = async (
  tx: TxScope,
  image: Image,
  input: ImageWriteInput,
): Promise<UpdateTxOutcome> => {
  const missing = await missingImageUseTargets(tx, input.items ?? []);
  refuseTheWriteOn(
    missing.length === 0
      ? null
      : `items must name existing records: ${missing
          .map(imageUseTargets.key)
          .join(", ")}`,
  );
  const row = await updateImageRecord(
    image.id,
    { altText: input.altText, name: input.name },
    tx,
  );
  if (row === null) return { notFound: true };
  if (input.items !== null && input.items !== undefined) {
    await setItemsForImage(image.id, input.items, tx);
  }
  return { row };
};

/** The image's three write commands: the upload boundary on create, the
 *  metadata-and-links transaction on update, and the record delete. */
const imageWrites = {
  create: async (input: ImageWriteInput): Promise<WriteVerdict<Image>> => {
    const ruled = imageRule(input);
    if (!ruled.ok) return { kind: "refused", message: ruled.error };
    const image = await insertUploadedImage(ruled.value);
    await logImageAction("uploaded", image.name);
    return { kind: "written", row: image };
  },
  remove: (id: number) =>
    deleteAndLog(id, {
      destroy: (image) => deleteImageRecord(image.id),
      load: getImageById,
      log: (image) => logImageAction("deleted", image.name),
    }),
  update: async (
    id: number,
    input: ImageWriteInput,
  ): Promise<WriteVerdict<Image>> => {
    const stored = await getImageById(id);
    if (stored === null) return { kind: "not-found" };
    const ruled = imageRule(input);
    if (!ruled.ok) return { kind: "refused", message: ruled.error };
    const outcome = await withTransaction((tx) =>
      updateInTransaction(tx, stored, ruled.value),
    ).catch((error) => ({
      conflict: transactionValidationMessageOrRethrow(error),
    }));
    if ("conflict" in outcome) {
      return { kind: "refused", message: outcome.conflict };
    }
    if ("notFound" in outcome) return { kind: "not-found" };
    await logImageAction("updated", outcome.row.name);
    return { kind: "written", row: outcome.row };
  },
} as const;

export const imageRecord = defineNamedRowRecord<Image, ImageWriteInput>({
  activityName: "Image",
  api: ADMIN_API_RESOURCES.images,
  deleteDestination: "imageDelete",
  getAll: async () => sortByName(await getAllImages(), byNameThenUpload),
  list: "images",
  load: getImageById,
  rule: imageRule,
  table: imagesTable,
  write: imageWrites,
});
