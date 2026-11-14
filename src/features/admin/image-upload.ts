/**
 * Shared first-class image form handling. The record module owns the upload,
 * the record insert, and the metadata rule. This module adapts a multipart
 * form to them.
 */

import { t } from "#i18n";
import { formDataToParams } from "#routes/csrf.ts";
import { redirect } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  type ImageFile,
  type ImageMetadata,
  imageMetadata,
  insertUploadedImage,
  uploadImageFiles,
} from "#shared/records/images.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { Image } from "#types";

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

/** Store one image: its two files, then its record. A failed insert removes
 *  the files it just wrote, so no upload is left without a library entry. */
const storeImage = async (
  metadata: ImageMetadata,
  file: ImageFile,
): Promise<Result<Image>> => {
  const filenames = await uploadImageFiles(file);
  if (!filenames.ok) return filenames;
  return okResult(
    await insertUploadedImage({ ...metadata, ...filenames.value }),
  );
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
