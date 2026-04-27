/**
 * Admin backup/restore routes — owner only
 *
 * Provides database backup (export to .zip) and restore (import from .zip)
 * functionality for remote databases. Backups are stored unencrypted on CDN
 * storage since the sensitive data is already encrypted at the field level.
 */

import { createActionHandler } from "#routes/admin/actions.ts";
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { OWNER_MULTIPART, requireOwnerOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { getEncryptionKeyString } from "#shared/crypto/encryption.ts";
import {
  countZipStatements,
  createAndUploadBackup,
  dbName,
  isRemoteDatabase,
  readManifest,
  restoreFromZip,
} from "#shared/db/backup.ts";
import { SCHEMA_HASH } from "#shared/db/migrations.ts";
import {
  deleteFile,
  downloadRaw,
  isStorageEnabled,
  listFiles,
  uploadRaw,
} from "#shared/storage.ts";
import {
  adminBackupPage,
  adminRestoreConfirmPage,
  type BackupEntry,
  type BackupPageState,
  RESTORE_CONFIRM_PHRASE,
} from "#templates/admin/backup.tsx";

const RESTORE_PENDING_PREFIX = "restore-pending-";

/** Build the prefix for listing backups scoped to the current DB */
const backupPrefix = (): string => `backup-${dbName()}-`;

/** Parse a backup filename into display info */
const parseBackupEntry = (filename: string): BackupEntry => {
  // Format: backup-{dbname}-2024-01-15T12-30-00-000Z.zip
  const withoutPrefix = filename.slice(backupPrefix().length);
  const timestamp = withoutPrefix.replace(/\.zip$/, "");
  return { filename, timestamp };
};

/** List existing backups from storage scoped to the current DB */
const listBackups = async (): Promise<BackupEntry[]> => {
  const files = await listFiles(backupPrefix());
  return files.filter((f) => f.endsWith(".zip")).map(parseBackupEntry);
};

/** Delete any stale restore-pending temp files (best effort, fire-and-forget) */
const cleanupStalePendingFiles = async (): Promise<void> => {
  const files = await listFiles(RESTORE_PENDING_PREFIX);
  for (const file of files) {
    await deleteFile(file).catch(() => {});
  }
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
    // Clean up any abandoned restore-pending temp files (fire-and-forget)
    if (isStorageEnabled()) cleanupStalePendingFiles().catch(() => {});
    const state = await getBackupPageState();
    return htmlResponse(
      adminBackupPage(session, state, flash.error, flash.success),
    );
  });

/** POST /admin/backup/create — create a new backup */
const handleBackupCreate: TypedRouteHandler<"POST /admin/backup/create"> =
  createActionHandler({
    auth: "owner",
    execute: async () => {
      await createAndUploadBackup();
    },
    message: "Database backup created",
    successRedirect: "/admin/backup",
  });

/** GET /admin/backup/download/:filename — download a backup file */
const handleBackupDownload: TypedRouteHandler<
  "GET /admin/backup/download/:filename"
> = (request, { filename }) =>
  requireOwnerOr(request, async () => {
    if (!filename.startsWith(backupPrefix()) || !filename.endsWith(".zip")) {
      return htmlResponse("Invalid backup filename", 400);
    }

    const data = await downloadRaw(filename);
    if (!data) return htmlResponse("Backup file not found", 404);

    const body = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-disposition": `attachment; filename="${filename}"`,
        "content-type": "application/zip",
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
    const schemaMismatch =
      manifest !== null && manifest.schemaHash !== SCHEMA_HASH;

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
const handleBackupRestoreConfirm: TypedRouteHandler<"POST /admin/backup/restore/confirm"> =
  createActionHandler({
    auth: "owner",
    execute: async (_session, form) => {
      const filename = form.getString("backup_filename");
      if (
        !filename?.startsWith(RESTORE_PENDING_PREFIX) ||
        !filename.endsWith(".zip")
      ) {
        throw new Error("Invalid backup reference");
      }

      const error = verifyOrRedirect(
        form,
        RESTORE_CONFIRM_PHRASE,
        "/admin/backup",
        "Confirmation phrase",
        "restore",
      );
      if (error) throw new Error("Confirmation phrase does not match");

      const data = await downloadRaw(filename);
      if (!data) {
        throw new Error(
          "Backup file expired or not found. Please upload again.",
        );
      }

      try {
        await restoreFromZip(data);
      } finally {
        // Clean up the temp file whether restore succeeds or fails
        await deleteFile(filename).catch(() => {});
      }
    },
    message: "Database restored from backup",
    successRedirect: "/admin/backup",
  });

/** Backup routes */
export const backupRoutes = defineRoutes({
  "GET /admin/backup": handleBackupGet,
  "GET /admin/backup/download/:filename": handleBackupDownload,
  "POST /admin/backup/create": handleBackupCreate,
  "POST /admin/backup/restore": handleBackupRestore,
  "POST /admin/backup/restore/confirm": handleBackupRestoreConfirm,
});
