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
/* jscpd:ignore-start */
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
/* jscpd:ignore-end */
import { clearSessionCookie } from "#shared/cookies.ts";
import { getEncryptionKeyString } from "#shared/crypto/encryption.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import {
  backupDir,
  countZipStatements,
  createAndUploadBackup,
  isBackupLeaf,
  isBackupPath,
  isRemoteDatabase,
  parseBackupTime,
  readManifest,
  restoreFromZip,
} from "#shared/db/backup.ts";
import { SCHEMA_HASH } from "#shared/db/migrations.ts";
import { formatBytes, MAX_BACKUPS } from "#shared/limits.ts";
import {
  deleteFile,
  downloadRaw,
  getBasename,
  isStorageEnabled,
  listFilesWithMeta,
  type StorageFileMeta,
  uploadRaw,
} from "#shared/storage.ts";
import { readRecordedScriptCommit } from "#shared/update.ts";
import {
  adminBackupPage,
  adminRestoreConfirmPage,
  type BackupEntry,
  type BackupPageState,
  RESTORE_CONFIRM_PHRASE,
} from "#templates/admin/backup.tsx";

const RESTORE_PENDING_PREFIX = "restore-pending-";

/** A full git commit SHA (40 lowercase hex) — what restore-deploy requires and
 *  the only shape we echo back from restored (possibly untrusted) settings. */
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Reject path-traversal payloads in backup filenames.
 * Legitimate backup names are flat (no directory separators) and server-generated,
 * so any `/`, `\`, or `..` component is always malicious input.
 */
const isSafeBackupFilename = (filename: string): boolean =>
  !filename.includes("/") &&
  !filename.includes("\\") &&
  !filename.includes("..");

/** Parse a backup file into display info (friendly date + human size). The
 *  download link uses the bare leaf; filenames are server-generated, so
 *  parseBackupTime always succeeds. */
const parseBackupEntry = (file: StorageFileMeta): BackupEntry => ({
  filename: getBasename(file.name),
  label: formatDatetimeLabel(
    new Date(parseBackupTime(file.name)!).toISOString(),
  ),
  sizeLabel: formatBytes(file.size),
});

/** Pick out the backups from a folder listing, newest first. Filenames embed
 *  ISO timestamps, so name order is chronological. */
const toBackupEntries = (files: StorageFileMeta[]): BackupEntry[] =>
  files
    .filter((f) => isBackupPath(f.name))
    .reverse()
    .map(parseBackupEntry);

/** Delete stale restore-pending temp files left by abandoned uploads.
 *  Best-effort — allSettled swallows individual failures. */
const cleanupStalePendingFiles = (files: StorageFileMeta[]): Promise<unknown> =>
  Promise.allSettled(
    files
      .filter((f) => f.name.startsWith(RESTORE_PENDING_PREFIX))
      .map((f) => deleteFile(f.name)),
  );

/** Build page state: this DB's backups (from its own folder) plus a best-effort
 *  sweep of stale restore-pending temp files at the storage root. */
const getBackupPageState = async (): Promise<BackupPageState> => {
  const base = {
    encryptionKey: getEncryptionKeyString(),
    isRemote: isRemoteDatabase(),
    maxBackups: MAX_BACKUPS,
    storageEnabled: isStorageEnabled(),
  };
  if (!isStorageEnabled()) return { ...base, backups: [] };

  try {
    // Backups live in this DB's folder; restore-pending temp files sit at the
    // storage root. One listing each, in parallel.
    const [backupFiles, rootFiles] = await Promise.all([
      listFilesWithMeta(backupDir()),
      listFilesWithMeta(""),
    ]);
    await cleanupStalePendingFiles(rootFiles);
    return { ...base, backups: toBackupEntries(backupFiles) };
  } catch {
    // Storage listing unavailable — still render the page (encryption key,
    // forms) rather than failing the whole request on a transient CDN error.
    return { ...base, backups: [] };
  }
};

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
    // The route param is a bare leaf. The anchored leaf check rejects anything
    // that isn't "backup-{timestamp}.zip" (path separators included), and we
    // resolve it inside this DB's own folder — so it can only reach our backups.
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
    // After restore, the operator's current session is no longer valid (the
    // backup pre-dates it). Redirect to /admin/login and clear the session
    // cookie so the flash appears on the login page instead of being consumed
    // by an intermediate auth-redirect that the operator never sees.
    cookie: clearSessionCookie(),
    execute: async (_session, form) => {
      const filename = form.getString("backup_filename");
      if (
        !filename?.startsWith(RESTORE_PENDING_PREFIX) ||
        !filename.endsWith(".zip") ||
        !isSafeBackupFilename(filename)
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
        await Promise.allSettled([deleteFile(filename)]);
      }
    },
    // The restored data carries the commit the site was running when the backup
    // was taken (recordScriptVersion writes it on boot). Surface the full SHA so
    // the operator can redeploy that commit; restore only rolls back data, never
    // code. The value comes from restored settings (an uploaded backup could
    // hold anything), so only present it when it is a real 40-char SHA — both
    // because the restore-deploy workflow requires one and to keep an oversized
    // value out of the flash cookie. Read straight after the restore, before the
    // next request's initDb re-stamps the running commit.
    message: async () => {
      const commit = await readRecordedScriptCommit();
      return FULL_COMMIT_SHA.test(commit)
        ? `Database restored from backup. It was running commit ${commit} — run the restore-deploy workflow with that commit to restore the code to this point in time.`
        : "Database restored from backup";
    },
    // Validation failures (bad filename, wrong phrase, file not found) are
    // operator mistakes, not completed restores — keep those on the backup page.
    onError: (error) => errorRedirect("/admin/backup", error.message),
    successRedirect: "/admin/login",
  });

/** Backup routes */
export const backupRoutes = defineRoutes({
  "GET /admin/backup": handleBackupGet,
  "GET /admin/backup/download/:filename": handleBackupDownload,
  "POST /admin/backup/create": handleBackupCreate,
  "POST /admin/backup/restore": handleBackupRestore,
  "POST /admin/backup/restore/confirm": handleBackupRestoreConfirm,
});
