/**
 * Shared first-class image form handling.
 */

import { t } from "#i18n";
import { formDataToParams } from "#routes/csrf.ts";
import { redirect } from "#routes/response.ts";
import { imagesTable } from "#shared/db/images.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  FULL_IMAGE_TARGET,
  THUMB_IMAGE_TARGET,
} from "#shared/images/targets.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteFile,
  uploadImageTargets,
  validateImage,
} from "#shared/storage.ts";
import type { Image } from "#shared/types.ts";
import {
  type NonEmptyString,
  nonEmptyString,
} from "#shared/validation/string.ts";

type ImageMetadata = {
  name: string;
  altText: string;
};

export const imageMetadataFromForm = (
  form: FormParams,
): Result<ImageMetadata> => {
  const name = form.getString("name");
  return name === ""
    ? errorResult(t("images.error.name_required"))
    : okResult({ altText: form.getString("alt_text"), name });
};

const imageFileFromForm = (formData: FormData): Result<File> => {
  const entry = formData.get("image");
  return entry instanceof File && entry.size > 0
    ? okResult(entry)
    : errorResult(t("images.error.file_required"));
};

const uploadedFilenames = async (
  file: File,
): Promise<
  Result<{ filename: NonEmptyString; filenameThumb: NonEmptyString }>
> => {
  if (!isStorageEnabled()) {
    return errorResult(t("images.storage_off"));
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const validation = validateImage(data, file.type);
  if (!validation.valid) {
    return errorResult(IMAGE_ERROR_MESSAGES[validation.error]);
  }
  try {
    const [filename, filenameThumb] = await uploadImageTargets(
      data,
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

export const createImageFromUpload = async (
  formData: FormData,
): Promise<Result<Image>> => {
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
