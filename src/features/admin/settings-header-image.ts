/**
 * Admin header image settings routes - upload and delete the public-site
 * header image. Owner-only access enforced via settingsRoute / OWNER_MULTIPART.
 */

import { settingsRoute } from "#routes/admin/settings-helpers.ts";
import { OWNER_MULTIPART, withAuth } from "#routes/auth.ts";
import { errorRedirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { fail, ok } from "#shared/response.ts";
import {
  deleteFile,
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteFile,
  uploadImage,
  validateImage,
} from "#shared/storage.ts";

/** Handle POST /admin/settings/header-image - owner only (multipart) */
export const handleHeaderImagePost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_MULTIPART, async (_session, formData) => {
    if (!isStorageEnabled()) {
      return errorRedirect(
        "/admin/settings",
        "Image storage is not configured",
        "settings-header-image",
      );
    }

    const entry = formData.get("header_image");
    if (!(entry instanceof File) || entry.size === 0) {
      return errorRedirect(
        "/admin/settings",
        "No image file provided",
        "settings-header-image",
      );
    }

    const data = new Uint8Array(await entry.arrayBuffer());
    const validation = validateImage(data, entry.type);
    if (!validation.valid) {
      return errorRedirect(
        "/admin/settings",
        IMAGE_ERROR_MESSAGES[validation.error],
        "settings-header-image",
      );
    }

    // Delete old header image if one exists (best-effort, don't block new upload)
    const existingUrl = settings.headerImageUrl;
    if (existingUrl) {
      await tryDeleteFile(
        existingUrl,
        undefined,
        `header image: ${existingUrl}`,
      );
    }

    const [uploadResult] = await Promise.allSettled([
      uploadImage(data, validation.detectedType),
    ]);
    if (uploadResult.status === "fulfilled") {
      await settings.update.headerImageUrl(uploadResult.value);
      await logActivity("Header image uploaded");
      return ok("/admin/settings", "Header image uploaded", {
        formId: "settings-header-image",
      });
    }
    const uploadDetail = `Header image upload failed: ${String(
      uploadResult.reason,
    )}`;
    logError({ code: ErrorCode.STORAGE_UPLOAD, detail: uploadDetail });
    return fail("/admin/settings", "Header image upload failed", {
      formId: "settings-header-image",
    });
  });

/** Handle POST /admin/settings/header-image/delete - owner only */
export const handleHeaderImageDeletePost = settingsRoute(
  async (_form, _errorPage) => {
    if (!settings.headerImageUrl) {
      return errorRedirect(
        "/admin/settings",
        "No header image to remove",
        "settings-header-image",
      );
    }

    const [deleteResult] = await Promise.allSettled([
      deleteFile(settings.headerImageUrl),
    ]);
    if (deleteResult.status === "fulfilled") {
      await settings.update.headerImageUrl("");
      await logActivity("Header image removed");
      return ok("/admin/settings", "Header image removed", {
        formId: "settings-header-image-delete",
      });
    }
    const deleteDetail = `Header image removal failed: ${String(
      deleteResult.reason,
    )}`;
    logError({ code: ErrorCode.STORAGE_DELETE, detail: deleteDetail });
    return fail("/admin/settings", "Header image removal failed", {
      formId: "settings-header-image-delete",
    });
  },
);
