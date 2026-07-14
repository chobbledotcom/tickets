import { compact } from "#fp";
import { requireEnv } from "#shared/env.ts";
import { MAX_BACKUPS } from "#shared/limits.ts";
import { deleteFile, getBasename, listFiles } from "#shared/storage.ts";

export const isRemoteDatabase = (): boolean => {
  const url = requireEnv("DB_URL");
  return url.startsWith("libsql://") || url.startsWith("https://");
};

/** Extract the stable database identity used as its storage folder. */
export const dbName = (url: string = requireEnv("DB_URL")): string => {
  if (!URL.canParse(url)) return "local";
  const host = new URL(url).hostname;
  const first = host.split(".")[0]!;
  if (host.endsWith(".turso.io")) return first;
  const dashIndex = first.indexOf("-");
  return dashIndex === -1 ? first : first.slice(dashIndex + 1);
};

export const backupDir = (name: string = dbName()): string => `${name}/`;

export const backupLeaf = (timestamp: string): string =>
  `backup-${timestamp}.zip`;

export const backupKey = (timestamp: string, name: string = dbName()): string =>
  `${backupDir(name)}${backupLeaf(timestamp)}`;

export const backupTimestamp = (date = new Date()): string =>
  date.toISOString().replace(/[:.]/g, "-");

/** One hour: the pre-upgrade gate requires a backup newer than this. */
export const BACKUP_REQUIRED_WITHIN_MS = 60 * 60 * 1000;

const BACKUP_TIMESTAMP = String.raw`(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z`;
const BACKUP_TIME_TAIL = new RegExp(`${BACKUP_TIMESTAMP}\\.zip$`);
const BACKUP_LEAF = new RegExp(`^backup-${BACKUP_TIMESTAMP}\\.zip$`);

export const parseBackupTime = (filename: string): number | null => {
  const match = filename.match(BACKUP_TIME_TAIL);
  if (!match) return null;
  const milliseconds = Date.parse(
    `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`,
  );
  return Number.isNaN(milliseconds) ? null : milliseconds;
};

export const isBackupLeaf = (leaf: string): boolean => BACKUP_LEAF.test(leaf);

export const isBackupPath = (key: string): boolean =>
  isBackupLeaf(getBasename(key));

export const hasRecentBackup = async (
  maxAgeMs: number = BACKUP_REQUIRED_WITHIN_MS,
  name: string = dbName(),
): Promise<boolean> => {
  const now = Date.now();
  const files = await listFiles(backupDir(name));
  return files.some((file) => {
    if (!isBackupPath(file)) return false;
    const milliseconds = parseBackupTime(file);
    return milliseconds !== null && now - milliseconds < maxAgeMs;
  });
};

/** Remove oldest backups beyond `keep`; storage deletion is best-effort. */
export const pruneOldBackups = async (
  keep = MAX_BACKUPS,
): Promise<string[]> => {
  const files = await listFiles(backupDir());
  const stale = files.filter(isBackupPath).reverse().slice(keep);
  const removed = await Promise.all(
    stale.map(async (file) => {
      try {
        await deleteFile(file);
        return file;
      } catch {
        return null;
      }
    }),
  );
  return compact(removed);
};
