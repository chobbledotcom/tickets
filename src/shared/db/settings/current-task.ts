/**
 * The `current_task` lock — prevents two heavy operations (a backup, a
 * migration, etc.) running at once. The lock is a single `settings` table row
 * whose value is the running task's name: atomic `UPDATE … WHERE value = ''`
 * claims it, and the `finally` clears it. The lock is per-node (a single
 * edge isolate or process), not cross-isolate.
 */

import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { type Expr, equal, given, valued } from "#db/select/expression.ts";
import { tables } from "#db/select/tables.ts";
import { syncCache } from "#db/settings/cache.ts";
import { writeOrDelete } from "#db/settings/raw-writes.ts";
import { setSnapshotField } from "#db/settings/snapshot.ts";
import { sql } from "#db/sql.ts";
import { insertInto, update } from "#db/write.ts";
import { t } from "#i18n";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

/** The stored settings version, or 0 when no version row exists. */
const storedVersion = (): Expr<number> =>
  valued(
    sql`CAST(COALESCE((SELECT value FROM settings WHERE key = ${CONFIG_KEYS.SETTINGS_VERSION}), '0') AS INTEGER)`,
  );

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
    insertInto(
      tables.settings,
      { key: CONFIG_KEYS.CURRENT_TASK, value: "" },
      { or: "IGNORE" },
    ),
  );
  // Atomic claim: only succeeds when no task is running
  const claim = await executeWithoutCacheInvalidation(
    update(tables.settings, { value: taskName }).where((row) => [
      equal(row.key, CONFIG_KEYS.CURRENT_TASK),
      equal(row.value, ""),
      given(expectedVersion, (version) => equal(storedVersion(), version)),
    ]),
  );
  if (claim.rowsAffected === 0) {
    const version = await executeWithoutCacheInvalidation(
      sql`SELECT ${storedVersion()} AS value`,
    );
    const currentVersion = Number(version.rows[0]?.value);
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
