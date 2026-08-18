/** Admin backup routes. Restores run out of band through `deno task restore`. */

import { t } from "#i18n";
import { createActionHandler } from "#routes/admin/actions.ts";
import { ownerPage, requireOwnerOr } from "#routes/auth.ts";
import { downloadResponse, htmlResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { getEncryptionKeyString } from "#shared/crypto/encryption.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import { backupBudget, createAndUploadBackup } from "#shared/db/backup.ts";
import {
  backupDir,
  backupTimestamp,
  isBackupLeaf,
  isBackupPath,
  isRemoteDatabase,
  parseBackupTime,
} from "#shared/db/backup-storage.ts";
import { errorMessage } from "#shared/error-message.ts";
import { formatBytes, MAX_BACKUPS } from "#shared/limits.ts";
import {
  downloadRaw,
  getBasename,
  isStorageEnabled,
  listFilesWithMeta,
  type StorageFileMeta,
  storageZoneName,
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
    backupFolder: backupDir(),
    encryptionKey: getEncryptionKeyString(),
    isRemote: isRemoteDatabase(),
    listingError: null,
    maxBackups: MAX_BACKUPS,
    storageEnabled: isStorageEnabled(),
    storageZone: storageZoneName(),
  };
  if (!base.storageEnabled) {
    return { ...base, backups: [], createBlocked: null };
  }

  const budget = await backupBudget();
  const createBlocked = budget.fits
    ? null
    : { available: budget.available, needed: budget.needed };
  try {
    return {
      ...base,
      backups: toBackupEntries(await listFilesWithMeta(backupDir())),
      createBlocked,
    };
  } catch (err) {
    // A storage listing failure must not hide the encryption key or the
    // out-of-band restore instructions — but it must be shown as a failure,
    // never dressed up as an empty backup list.
    return {
      ...base,
      backups: [],
      createBlocked,
      listingError: errorMessage(err),
    };
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
      // Refuse up front when the dump cannot fit the request's subrequest
      // allowance, instead of crashing partway through the table reads.
      const budget = await backupBudget();
      if (!budget.fits) {
        throw new Error(t("backup.create_too_large_error"));
      }
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
    return downloadResponse(body, filename, "application/zip");
  });

export const adminHandlers = defineRoutes({
  "GET /admin/backup": handleBackupGet,
  "GET /admin/backup/download/:filename": handleBackupDownload,
  "POST /admin/backup/create": handleBackupCreate,
});
