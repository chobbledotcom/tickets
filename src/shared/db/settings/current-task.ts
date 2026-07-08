/**
 * The `current_task` lock — prevents two heavy operations (a backup, a
 * migration, etc.) running at once. The lock is a single `settings` table row
 * whose value is the running task's name: atomic `UPDATE … WHERE value = ''`
 * claims it, and the `finally` clears it. The lock is per-node (a single
 * edge isolate or process), not cross-isolate.
 */

import { executeWithoutCacheInvalidation } from "#shared/db/client.ts";
import { syncCache } from "#shared/db/settings/cache.ts";
import { writeOrDelete } from "#shared/db/settings/raw-writes.ts";
import { setSnapshotField } from "#shared/db/settings/snapshot.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

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
): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  // Ensure the row exists (no-op if already present)
  await executeWithoutCacheInvalidation(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, '')",
    [CONFIG_KEYS.CURRENT_TASK],
  );
  // Atomic claim: only succeeds when no task is running
  const claim = await executeWithoutCacheInvalidation(
    "UPDATE settings SET value = ? WHERE key = ? AND value = ''",
    [taskName, CONFIG_KEYS.CURRENT_TASK],
  );
  if (claim.rowsAffected === 0) {
    return {
      error: "Another task is already in progress",
      ok: false,
    };
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
