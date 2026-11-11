/**
 * Shared first-class image form handling.
 */

import { insertImageRecord } from "#db/images.ts";
import { t } from "#i18n";
import { formDataToParams } from "#routes/csrf.ts";
import { redirect } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  FULL_IMAGE_TARGET,
  THUMB_IMAGE_TARGET,
} from "#shared/images/targets.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
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

export const imageMetadataFromForm = (
  form: FormParams,
): Result<ImageMetadata> =>
  imageMetadata(form.getString("name"), form.getString("alt_text"));

const imageFileFromForm = (formData: FormData): Result<File> => {
  const entry = formData.get("image");
  return entry instanceof File && entry.size > 0
    ? okResult(entry)
    : errorResult(t("images.error.file_required"));
};

const uploadedFilenames = async (
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

/** Store one image: its two files, then its record. A record write that fails
 *  removes the files it just wrote, so no upload is left without a library
 *  entry. */
export const storeImage = async (
  metadata: ImageMetadata,
  file: ImageFile,
): Promise<Result<Image>> => {
  const filenames = await uploadedFilenames(file);
  if (!filenames.ok) return filenames;
  try {
    const image = await insertImageRecord({
      ...metadata,
      ...filenames.value,
    });
    return okResult(image);
  } catch (err) {
    await tryDeleteFile(
      filenames.value.filename,
      undefined,
      "failed image record cleanup",
    );
    await tryDeleteFile(
      filenames.value.filenameThumb,
      undefined,
      "failed image thumbnail record cleanup",
    );
    throw err;
  }
};

export const createImageFromUpload = async (
  formData: FormData,
): Promise<Result<Image>> => {
  const metadata = imageMetadataFromForm(formDataToParams(formData));
  if (!metadata.ok) return metadata;
  const file = imageFileFromForm(formData);
  if (!file.ok) return file;
  return storeImage(metadata.value, {
    bytes: new Uint8Array(await file.value.arrayBuffer()),
    contentType: file.value.type,
  });
};

export const withUploadedImage = async (
  formData: FormData,
  failurePath: string,
  useImage: ResponseHandler<[value: Image]>,
): Promise<Response> => {
  const result = await createImageFromUpload(formData);
  return result.ok
    ? useImage(result.value)
    : redirect(failurePath, result.error, false);
};
