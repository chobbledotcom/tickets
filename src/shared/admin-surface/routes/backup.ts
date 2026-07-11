import { operation, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getBackup", "backup", "GET", "/admin/backup"),
  route(
    "getBackupDownloadByFilename",
    "backup",
    "GET",
    "/admin/backup/download/:filename",
  ),
  operation("postBackupCreate", "backup", "/admin/backup/create"),
  route("postBackupRestore", "backup", "POST", "/admin/backup/restore"),
  route(
    "postBackupRestoreConfirm",
    "backup",
    "POST",
    "/admin/backup/restore/confirm",
  ),
] as const;
