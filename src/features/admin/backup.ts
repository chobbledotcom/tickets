/** Admin backup routes. Restores run out of band through `deno task restore`. */

import { createActionHandler } from "#routes/admin/actions.ts";
import { ownerPage, requireOwnerOr } from "#routes/auth.ts";
import { htmlResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { getEncryptionKeyString } from "#shared/crypto/encryption.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import { createAndUploadBackup } from "#shared/db/backup.ts";
import {
  backupDir,
  backupTimestamp,
  isBackupLeaf,
  isBackupPath,
  isRemoteDatabase,
  parseBackupTime,
} from "#shared/db/backup-storage.ts";
import { formatBytes, MAX_BACKUPS } from "#shared/limits.ts";
import {
  downloadRaw,
  getBasename,
  isStorageEnabled,
  listFilesWithMeta,
  type StorageFileMeta,
} from "#shared/storage.ts";
import {
  adminBackupPage,
  type BackupEntry,
  type BackupPageState,
} from "#templates/admin/backup.tsx";

/** Parse one server-generated backup filename into its display values. */
const parseBackupEntry = (file: StorageFileMeta): BackupEntry => {
  const takenAt = new Date(parseBackupTime(file.name)!);
  return {
    filename: getBasename(file.name),
    label: formatDatetimeLabel(takenAt.toISOString()),
    sizeLabel: formatBytes(file.size),
    timestamp: backupTimestamp(takenAt),
  };
};

/** Pick this database's backups out of a folder listing, newest first. */
const toBackupEntries = (files: StorageFileMeta[]): BackupEntry[] =>
  files
    .filter((file) => isBackupPath(file.name))
    .reverse()
    .map(parseBackupEntry);

const getBackupPageState = async (): Promise<BackupPageState> => {
  const base = {
    encryptionKey: getEncryptionKeyString(),
    isRemote: isRemoteDatabase(),
    maxBackups: MAX_BACKUPS,
    storageEnabled: isStorageEnabled(),
  };
  if (!isStorageEnabled()) return { ...base, backups: [] };

  try {
    return {
      ...base,
      backups: toBackupEntries(await listFilesWithMeta(backupDir())),
    };
  } catch {
    // A transient storage listing failure must not hide the encryption key or
    // the out-of-band restore instructions.
    return { ...base, backups: [] };
  }
};

const handleBackupGet: TypedRouteHandler<"GET /admin/backup"> = ownerPage(
  async (session, _request, flash) =>
    adminBackupPage(
      session,
      await getBackupPageState(),
      flash.error,
      flash.success,
    ),
);

const handleBackupCreate: TypedRouteHandler<"POST /admin/backup/create"> =
  createActionHandler({
    auth: "owner",
    execute: async () => {
      await createAndUploadBackup();
    },
    message: "Database backup created",
    successRedirect: "/admin/backup",
  });

const handleBackupDownload: TypedRouteHandler<
  "GET /admin/backup/download/:filename"
> = (request, { filename }) =>
  requireOwnerOr(request, async () => {
    if (!isBackupLeaf(filename)) {
      return htmlResponse("Invalid backup filename", 400);
    }

    const data = await downloadRaw(`${backupDir()}${filename}`);
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

export const adminHandlers = defineRoutes({
  "GET /admin/backup": handleBackupGet,
  "GET /admin/backup/download/:filename": handleBackupDownload,
  "POST /admin/backup/create": handleBackupCreate,
});
