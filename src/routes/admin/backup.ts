/**
 * Admin backup/restore routes — owner only
 *
 * Provides database backup (export to .sql) and restore (import from .sql)
 * functionality for remote databases. Backups are stored unencrypted on CDN
 * storage since the sensitive data is already encrypted at the field level.
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  backupFilename,
  backupTimestamp,
  createBackup,
  isRemoteDatabase,
  restoreFromSql,
} from "#lib/db/backup.ts";
import { getEncryptionKeyString } from "#lib/crypto/encryption.ts";
import {
  deleteFile,
  downloadRaw,
  isStorageEnabled,
  listRawFiles,
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
  type BackupFile,
  type BackupPageState,
  RESTORE_CONFIRM_PHRASE,
} from "#templates/admin/backup.tsx";

const BACKUP_PREFIX = "backup-";

/** Parse a backup filename into display info */
const parseBackupFile = (filename: string): BackupFile => {
  // Format: backup-2024-01-15T12-30-00-000Z-tablename.sql
  const withoutPrefix = filename.slice(BACKUP_PREFIX.length);
  const timestampEnd = withoutPrefix.indexOf("-", withoutPrefix.indexOf("Z"));
  const timestamp = timestampEnd > 0
    ? withoutPrefix.slice(0, timestampEnd)
    : withoutPrefix.slice(0, withoutPrefix.lastIndexOf("-"));
  return { filename, timestamp };
};

/** List existing backups from storage, grouped by timestamp */
const listBackups = async (): Promise<BackupFile[]> => {
  const files = await listRawFiles(BACKUP_PREFIX);
  return files.map(parseBackupFile);
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
    const encoder = new TextEncoder();
    const timestamp = backupTimestamp();
    const tables = await createBackup();
    let fileCount = 0;

    for (const { table, sql } of tables) {
      const name = backupFilename(table, timestamp);
      await uploadRaw(encoder.encode(sql), name);
      fileCount++;
    }

    await logActivity(`Database backup created (${fileCount} tables)`);
    return redirect(
      "/admin/backup",
      `Backup created successfully (${fileCount} tables)`,
      true,
    );
  });

/** GET /admin/backup/download/:filename — download a backup file */
const handleBackupDownload: TypedRouteHandler<
  "GET /admin/backup/download/:filename"
> = (request, { filename }) =>
  requireOwnerOr(request, async () => {
    if (!filename.startsWith(BACKUP_PREFIX) || !filename.endsWith(".sql")) {
      return htmlResponse("Invalid backup filename", 400);
    }

    const data = await downloadRaw(filename);
    if (!data) return htmlResponse("Backup file not found", 404);

    return new Response(data.buffer as ArrayBuffer, {
      headers: {
        "content-type": "application/sql",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

/** POST /admin/backup/restore — upload a .sql file for review */
const handleBackupRestore: TypedRouteHandler<"POST /admin/backup/restore"> = (
  request,
) =>
  withAuth(request, OWNER_MULTIPART, async (session, formData) => {
    const file = formData.get("backup_file");
    if (!(file instanceof File) || file.size === 0) {
      return redirect("/admin/backup", "Please select a backup file", false);
    }

    const content = await file.text();
    const lines = content
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("--"));

    // Store the uploaded SQL temporarily so the confirm step can use it
    const tempFilename = `restore-pending-${crypto.randomUUID()}.sql`;
    const encoder = new TextEncoder();
    await uploadRaw(encoder.encode(content), tempFilename);

    return htmlResponse(
      adminRestoreConfirmPage(session, tempFilename, lines.length),
    );
  });

/** POST /admin/backup/restore/confirm — execute the restore after confirmation */
const handleBackupRestoreConfirm: TypedRouteHandler<
  "POST /admin/backup/restore/confirm"
> = (request) =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const filename = form.getString("backup_filename");
    if (!filename) {
      return redirect("/admin/backup", "Missing backup reference", false);
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

    const decoder = new TextDecoder();
    const sql = decoder.decode(data);
    await restoreFromSql(sql);

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
