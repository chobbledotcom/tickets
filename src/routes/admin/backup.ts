/**
 * Admin backup/restore routes — owner only
 *
 * Provides database backup (export to .zip) and restore (import from .zip)
 * functionality for remote databases. Backups are stored unencrypted on CDN
 * storage since the sensitive data is already encrypted at the field level.
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  backupFilename,
  backupTimestamp,
  countZipStatements,
  createBackupZip,
  isRemoteDatabase,
  readManifest,
  restoreFromZip,
} from "#lib/db/backup.ts";
import { getEncryptionKeyString } from "#lib/crypto/encryption.ts";
import { SCHEMA_HASH } from "#lib/db/migrations.ts";
import {
  deleteFile,
  downloadRaw,
  isStorageEnabled,
  listFiles,
  uploadRaw,
} from "#lib/storage.ts";
import { verifyOrRedirect } from "#routes/admin/utils.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  applyFlash,
  htmlResponse,
  OWNER_FORM,
  OWNER_MULTIPART,
  redirect,
  requireOwnerOr,
  withAuth,
} from "#routes/utils.ts";
import {
  adminBackupPage,
  adminRestoreConfirmPage,
  type BackupEntry,
  type BackupPageState,
  RESTORE_CONFIRM_PHRASE,
} from "#templates/admin/backup.tsx";

const BACKUP_PREFIX = "backup-";
const RESTORE_PENDING_PREFIX = "restore-pending-";

/** Parse a backup filename into display info */
const parseBackupEntry = (filename: string): BackupEntry => {
  // Format: backup-2024-01-15T12-30-00-000Z.zip
  const withoutPrefix = filename.slice(BACKUP_PREFIX.length);
  const timestamp = withoutPrefix.replace(/\.zip$/, "");
  return { filename, timestamp };
};

/** List existing backups from storage */
const listBackups = async (): Promise<BackupEntry[]> => {
  const files = await listFiles(BACKUP_PREFIX);
  return files.filter((f) => f.endsWith(".zip")).map(parseBackupEntry);
};

/** Build page state */
const getBackupPageState = async (): Promise<BackupPageState> => ({
  backups: isStorageEnabled() ? await listBackups() : [],
  encryptionKey: getEncryptionKeyString(),
  isRemote: isRemoteDatabase(),
  storageEnabled: isStorageEnabled(),
});

/** GET /admin/backup — show backup page */
const handleBackupGet: TypedRouteHandler<"GET /admin/backup"> = (request) =>
  requireOwnerOr(request, async (session) => {
    const flash = applyFlash(request);
    const state = await getBackupPageState();
    return htmlResponse(
      adminBackupPage(session, state, flash.error, flash.success),
    );
  });

/** POST /admin/backup/create — create a new backup */
const handleBackupCreate: TypedRouteHandler<"POST /admin/backup/create"> = (
  request,
) =>
  withAuth(request, OWNER_FORM, async () => {
    const timestamp = backupTimestamp();
    const zipData = await createBackupZip();
    const filename = backupFilename(timestamp);
    await uploadRaw(zipData, filename);

    await logActivity("Database backup created");
    return redirect(
      "/admin/backup",
      "Backup created successfully",
      true,
    );
  });

/** GET /admin/backup/download/:filename — download a backup file */
const handleBackupDownload: TypedRouteHandler<
  "GET /admin/backup/download/:filename"
> = (request, { filename }) =>
  requireOwnerOr(request, async () => {
    if (!filename.startsWith(BACKUP_PREFIX) || !filename.endsWith(".zip")) {
      return htmlResponse("Invalid backup filename", 400);
    }

    const data = await downloadRaw(filename);
    if (!data) return htmlResponse("Backup file not found", 404);

    return new Response(data.buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

/** POST /admin/backup/restore — upload a .zip file for review */
const handleBackupRestore: TypedRouteHandler<"POST /admin/backup/restore"> = (
  request,
) =>
  withAuth(request, OWNER_MULTIPART, async (session, formData) => {
    const file = formData.get("backup_file");
    if (!(file instanceof File) || file.size === 0) {
      return redirect("/admin/backup", "Please select a backup file", false);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    let statementCount: number;
    try {
      statementCount = countZipStatements(bytes);
    } catch {
      return redirect(
        "/admin/backup",
        "Invalid backup file. Please upload a valid .zip backup.",
        false,
      );
    }

    // Read manifest for schema compatibility check
    const manifest = readManifest(bytes);
    const schemaMismatch = manifest !== null &&
      manifest.schemaHash !== SCHEMA_HASH;

    // Store the uploaded zip temporarily so the confirm step can use it
    const tempFilename = `${RESTORE_PENDING_PREFIX}${crypto.randomUUID()}.zip`;
    await uploadRaw(bytes, tempFilename);

    return htmlResponse(
      adminRestoreConfirmPage(
        session,
        tempFilename,
        statementCount,
        undefined,
        schemaMismatch,
      ),
    );
  });

/** POST /admin/backup/restore/confirm — execute the restore after confirmation */
const handleBackupRestoreConfirm: TypedRouteHandler<
  "POST /admin/backup/restore/confirm"
> = (request) =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const filename = form.getString("backup_filename");
    if (
      !filename ||
      !filename.startsWith(RESTORE_PENDING_PREFIX) ||
      !filename.endsWith(".zip")
    ) {
      return redirect("/admin/backup", "Invalid backup reference", false);
    }

    const error = verifyOrRedirect(
      form,
      RESTORE_CONFIRM_PHRASE,
      "/admin/backup",
      "Confirmation phrase",
      "restore",
    );
    if (error) return error;

    const data = await downloadRaw(filename);
    if (!data) {
      return redirect(
        "/admin/backup",
        "Backup file expired or not found. Please upload again.",
        false,
      );
    }

    await restoreFromZip(data);

    // Clean up the temp file (best effort)
    try {
      await deleteFile(filename);
    } catch {
      // Ignore cleanup failures
    }

    await logActivity("Database restored from backup");
    return redirect(
      "/admin/backup",
      "Database restored successfully",
      true,
    );
  });

/** Backup routes */
export const backupRoutes = defineRoutes({
  "GET /admin/backup": handleBackupGet,
  "POST /admin/backup/create": handleBackupCreate,
  "GET /admin/backup/download/:filename": handleBackupDownload,
  "POST /admin/backup/restore": handleBackupRestore,
  "POST /admin/backup/restore/confirm": handleBackupRestoreConfirm,
});
