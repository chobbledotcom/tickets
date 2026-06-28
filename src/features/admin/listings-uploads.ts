/**
 * Listing file uploads and deletions.
 *
 * Handles the image/attachment fields on the create/edit forms (validate,
 * replace the old file, upload, persist) plus the standalone "remove file"
 * route handlers.
 */

/* jscpd:ignore-start */
import { compact } from "#fp";
import { CONTENT_FORM, listingReturnPath, withAuth } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getListingWithCount,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  ATTACHMENT_ERROR_MESSAGES,
  deleteFile,
  generateAttachmentFilename,
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteFile,
  uploadAttachment,
  uploadImage,
  validateAttachment,
  validateImage,
} from "#shared/storage.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { withEntityFromParam } from "./entity-handlers.ts";

/* jscpd:ignore-end */

/** Generic form file processor: extract, validate, replace old, upload, update listing */
const processFormFile = async (opts: {
  formData: FormData;
  fieldName: string;
  listingId: number;
  existingUrl?: string;
  validate: (data: Uint8Array, file: File) => string | null;
  upload: (data: Uint8Array, file: File) => Promise<Partial<ListingInput>>;
  label: string;
}): Promise<string | null> => {
  if (!isStorageEnabled()) return null;
  const entry = opts.formData.get(opts.fieldName);
  if (!(entry instanceof File) || entry.size === 0) {
    if (entry !== null && !(entry instanceof File)) {
      logDebug(
        "Storage",
        `${opts.label} field "${opts.fieldName}" is ${typeof entry}, not File`,
      );
    }
    return null;
  }

  const data = new Uint8Array(await entry.arrayBuffer());
  const error = opts.validate(data, entry);
  if (error) return error;

  if (opts.existingUrl) {
    await tryDeleteFile(
      opts.existingUrl,
      opts.listingId,
      `old ${opts.label} cleanup`,
    );
  }

  const [uploadResult] = await Promise.allSettled([opts.upload(data, entry)]);
  if (uploadResult.status === "fulfilled") {
    await listingsTable.update(opts.listingId, uploadResult.value);
    await logActivity(`${opts.label} uploaded for listing`, opts.listingId);
    return null;
  }
  const detail = `${opts.label} upload failed: ${String(uploadResult.reason)}`;
  logError({
    code: ErrorCode.STORAGE_UPLOAD,
    detail,
    listingId: opts.listingId,
  });
  return detail;
};

/** Process image from multipart form and attach to listing. Returns error message if validation fails. */
const processFormImage = (
  formData: FormData,
  listingId: number,
  existingImageUrl?: string,
): Promise<string | null> =>
  processFormFile({
    existingUrl: existingImageUrl,
    fieldName: "image",
    formData,
    label: "Image",
    listingId,
    upload: async (data, file) => {
      const v = validateImage(data, file.type) as {
        valid: true;
        detectedType: string;
      };
      const imageUrl = await uploadImage(data, v.detectedType);
      return { imageUrl };
    },
    validate: (data, file) => {
      const v = validateImage(data, file.type);
      return v.valid ? null : IMAGE_ERROR_MESSAGES[v.error];
    },
  });

/** Process attachment from multipart form and attach to listing. Returns error message if validation fails. */
const processFormAttachment = (
  formData: FormData,
  listingId: number,
  existingAttachmentUrl?: string,
): Promise<string | null> =>
  processFormFile({
    existingUrl: existingAttachmentUrl,
    fieldName: "attachment",
    formData,
    label: "Attachment",
    listingId,
    upload: async (data, file) => {
      const filename = generateAttachmentFilename(file.name);
      await uploadAttachment(data, filename);
      return { attachmentName: file.name, attachmentUrl: filename };
    },
    validate: (data) => {
      const v = validateAttachment(data);
      return v.valid ? null : ATTACHMENT_ERROR_MESSAGES[v.error];
    },
  });

/** Process image + attachment uploads and redirect, reporting any upload errors.
 *
 * `warning`, when set, is a non-fatal caveat to surface even when the create
 * succeeded (e.g. a duplicate that couldn't carry its required-child gate — Fix
 * 1): the redirect becomes a warning flash (not a plain success) carrying the
 * caveat, so the operator is never told an unqualified "success" for a partial
 * outcome. Upload errors still take precedence and are appended too. */
export const processUploadsAndRedirect = async (
  formData: FormData,
  listingId: number,
  redirectUrl: string,
  successMessage: string,
  existingImageUrl?: string,
  existingAttachmentUrl?: string,
  warning?: string | null,
): Promise<Response> => {
  const imageError = await processFormImage(
    formData,
    listingId,
    existingImageUrl,
  );
  const attachmentError = await processFormAttachment(
    formData,
    listingId,
    existingAttachmentUrl,
  );
  const caveats = compact([warning, ...[imageError, attachmentError]]);
  if (caveats.length > 0) {
    return redirect(
      redirectUrl,
      `${successMessage} but: ${caveats.join("; ")}`,
      false,
    );
  }
  return redirect(redirectUrl, successMessage, true);
};

/** Generic handler for deleting an listing's uploaded file (image or attachment) */
const handleFileDelete =
  (
    label: string,
    getUrl: (e: ListingWithCount) => string,
    clearFields: Partial<ListingInput>,
  ): TypedRouteHandler<`POST /admin/listing/:id/${string}/delete`> =>
  (request, { id }) =>
    withAuth(request, CONTENT_FORM, (session) =>
      withEntityFromParam(id, getListingWithCount, async (listing) => {
        // Staff return to the detail page; editors (who can't open it) to edit.
        const returnPath = listingReturnPath(session.adminLevel, id);
        const url = getUrl(listing);
        if (url) {
          const [deleteResult] = await Promise.allSettled([deleteFile(url)]);
          if (deleteResult.status === "fulfilled") {
            await listingsTable.update(id, clearFields);
            await logActivity(
              `${label} removed for '${listing.name}'`,
              listing,
            );
            return redirect(returnPath, `${label} removed`, true);
          }
          const detail = `${label} removal failed: ${String(
            deleteResult.reason,
          )}`;
          logError({
            code: ErrorCode.STORAGE_DELETE,
            detail,
            listingId: listing.id,
          });
          return redirect(returnPath, `${label} removal failed`, false);
        }
        return redirect(returnPath, `${label} removed`, true);
      }),
    );

/** Handle POST /admin/listing/:id/image/delete (delete listing image) */
export const handleImageDelete = handleFileDelete("Image", (e) => e.image_url, {
  imageUrl: "",
});

/** Handle POST /admin/listing/:id/attachment/delete (delete listing attachment) */
export const handleAttachmentDelete = handleFileDelete(
  "Attachment",
  (e) => e.attachment_url,
  { attachmentName: "", attachmentUrl: "" },
);
