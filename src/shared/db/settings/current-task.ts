/**
 * The `current_task` lock — prevents two heavy operations (a backup, a
 * migration, etc.) running at once. The lock is a single `settings` table row
 * whose value is the running task's name: atomic `UPDATE … WHERE value = ''`
 * claims it, and the `finally` clears it. The lock is per-node (a single
 * edge isolate or process), not cross-isolate.
 */

import { t } from "#i18n";
import { executeWithoutCacheInvalidation } from "#shared/db/client.ts";
import { syncCache } from "#shared/db/settings/cache.ts";
import { writeOrDelete } from "#shared/db/settings/raw-writes.ts";
import { setSnapshotField } from "#shared/db/settings/snapshot.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

const staleTask = (): { error: string; ok: false } => ({
  error: t("error.settings_changed"),
  ok: false,
});

/**
 * Run `fn` while holding the `current_task` lock for `taskName`.
 * If a task is already in progress, returns `{ ok: false, error }`.
 * The lock is always cleared when `fn` completes (success or error).
 *
 * Uses an atomic UPDATE … WHERE value = '' to avoid race conditions
 * between concurrent requests on the same node.
 */
export const withCurrentTask = async <T>(
  taskName: string,
  fn: () => Promise<T>,
  expectedVersion?: number | null,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  if (expectedVersion === null) return staleTask();
  // Ensure the row exists (no-op if already present)
  await executeWithoutCacheInvalidation(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, '')",
    [CONFIG_KEYS.CURRENT_TASK],
  );
  // Atomic claim: only succeeds when no task is running
  const claim = await executeWithoutCacheInvalidation(
    "UPDATE settings SET value = ?1 WHERE key = ?2 AND value = '' " +
      "AND (?3 IS NULL OR ?3 = CAST(COALESCE((SELECT value FROM settings WHERE key = ?4), '0') AS INTEGER))",
    [
      taskName,
      CONFIG_KEYS.CURRENT_TASK,
      expectedVersion ?? null,
      CONFIG_KEYS.SETTINGS_VERSION,
    ],
  );
  if (claim.rowsAffected === 0) {
    const version = await executeWithoutCacheInvalidation(
      "SELECT CAST(COALESCE((SELECT value FROM settings WHERE key = ?), '0') AS INTEGER) AS value",
      [CONFIG_KEYS.SETTINGS_VERSION],
    );
    const currentVersion = Number(version.rows[0]?.value);
    if (!Number.isInteger(currentVersion))
      throw new Error("Missing settings version");
    return expectedVersion !== undefined && expectedVersion !== currentVersion
      ? staleTask()
      : { error: "Another task is already in progress", ok: false };
  }
  syncCache((s) => {
    s.values.set(CONFIG_KEYS.CURRENT_TASK, taskName);
    s.loaded.add(CONFIG_KEYS.CURRENT_TASK);
  });
  setSnapshotField("current_task", taskName);
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    await writeOrDelete(CONFIG_KEYS.CURRENT_TASK, "");
    setSnapshotField("current_task", "");
  }
};
