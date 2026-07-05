/**
 * Shared first-class image form handling.
 */

import { t } from "#i18n";
import { formDataToParams } from "#routes/csrf.ts";
import { imagesTable } from "#shared/db/images.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  FULL_IMAGE_TARGET,
  THUMB_IMAGE_TARGET,
} from "#shared/images/targets.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteFile,
  uploadImageTargets,
  validateImage,
} from "#shared/storage.ts";
import type { Image } from "#shared/types.ts";

type ImageMetadata = {
  name: string;
  altText: string;
};

type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const imageMetadataFromForm = (
  form: FormParams,
): FormResult<ImageMetadata> => {
  const name = form.getString("name");
  return name === ""
    ? { error: t("images.error.name_required"), ok: false }
    : { ok: true, value: { altText: form.getString("alt_text"), name } };
};

const imageFileFromForm = (formData: FormData): FormResult<File> => {
  const entry = formData.get("image");
  return entry instanceof File && entry.size > 0
    ? { ok: true, value: entry }
    : { error: t("images.error.file_required"), ok: false };
};

const uploadedFilenames = async (
  file: File,
): Promise<FormResult<{ filename: string; filenameThumb: string }>> => {
  if (!isStorageEnabled()) {
    return { error: t("images.storage_off"), ok: false };
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const validation = validateImage(data, file.type);
  if (!validation.valid) {
    return { error: IMAGE_ERROR_MESSAGES[validation.error], ok: false };
  }
  try {
    const [filename, filenameThumb] = await uploadImageTargets(
      data,
      validation.detectedType,
      [FULL_IMAGE_TARGET, THUMB_IMAGE_TARGET],
    );
    return {
      ok: true,
      value: {
        filename: filename as string,
        filenameThumb: filenameThumb as string,
      },
    };
  } catch (err) {
    const detail = `Image upload failed: ${String(err)}`;
    logError({ code: ErrorCode.STORAGE_UPLOAD, detail });
    return { error: detail, ok: false };
  }
};

export const createImageFromUpload = async (
  formData: FormData,
): Promise<FormResult<Image>> => {
  const metadata = imageMetadataFromForm(formDataToParams(formData));
  if (!metadata.ok) return metadata;
  const file = imageFileFromForm(formData);
  if (!file.ok) return file;
  const filenames = await uploadedFilenames(file.value);
  if (!filenames.ok) return filenames;
  try {
    const image = await imagesTable.insert({
      ...metadata.value,
      ...filenames.value,
    });
    return { ok: true, value: image };
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
