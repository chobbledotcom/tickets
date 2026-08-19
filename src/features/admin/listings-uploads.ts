/**
 * Listing file uploads and deletions.
 *
 * Handles the attachment field on the create/edit forms (validate, replace the
 * old file, upload, persist) plus standalone attachment removal. First-class
 * images are linked from the image admin and item Images tabs.
 */

/* jscpd:ignore-start */
import { compact } from "#fp";
import { CONTENT_FORM, formGuard } from "#routes/auth.ts";
import { createIdEntityHandler } from "#routes/entity.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { entityReturnPath } from "#shared/admin-pages.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  ATTACHMENT_ERROR_MESSAGES,
  deleteFile,
  generateAttachmentFilename,
  isStorageEnabled,
  tryDeleteFile,
  uploadAttachment,
  validateAttachment,
} from "#shared/storage.ts";
import type { ListingWithCount } from "#shared/types.ts";

/* jscpd:ignore-end */

/** Generic form file processor: extract, validate, replace old, upload, update listing */
const processFormFile = async (opts: {
  formData: FormData;
  fieldName: string;
  listingId: number;
  existingUrl?: string | undefined;
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

/** Attaches a multipart upload to a listing, or says why it was rejected. */
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

/** Process attachment upload and redirect, reporting any upload errors.
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
  existingAttachmentUrl?: string,
  warning?: string | null,
): Promise<Response> => {
  const attachmentError = await processFormAttachment(
    formData,
    listingId,
    existingAttachmentUrl,
  );
  const caveats = compact([warning, attachmentError]);
  if (caveats.length > 0) {
    return redirect(
      redirectUrl,
      `${successMessage} but: ${caveats.join("; ")}`,
      false,
    );
  }
  return redirect(redirectUrl, successMessage, true);
};

const listingUploadHandler = createIdEntityHandler<ListingWithCount>(
  getListingWithCount,
)(formGuard(CONTENT_FORM));

/** Generic handler for deleting a listing's uploaded file. */
const handleFileDelete = (
  label: string,
  getUrl: (e: ListingWithCount) => string,
  clearFields: Partial<ListingInput>,
): TypedRouteHandler<`POST /admin/listing/:id/${string}/delete`> =>
  listingUploadHandler(async (listing, _session, _form, _request, { id }) => {
    const returnPath = entityReturnPath("/admin/listings", id);
    const url = getUrl(listing);
    if (url) {
      const [deleteResult] = await Promise.allSettled([deleteFile(url)]);
      if (deleteResult.status === "fulfilled") {
        await listingsTable.update(id, clearFields);
        await logActivity(`${label} removed for '${listing.name}'`, listing);
        return redirect(returnPath, `${label} removed`, true);
      }
      const detail = `${label} removal failed: ${String(deleteResult.reason)}`;
      logError({
        code: ErrorCode.STORAGE_DELETE,
        detail,
        listingId: listing.id,
      });
      return redirect(returnPath, `${label} removal failed`, false);
    }
    return redirect(returnPath, `${label} removed`, true);
  });

/** Handle POST /admin/listing/:id/attachment/delete (delete listing attachment) */
export const handleAttachmentDelete = handleFileDelete(
  "Attachment",
  (e) => e.attachment_url,
  { attachmentName: "", attachmentUrl: "" },
);
