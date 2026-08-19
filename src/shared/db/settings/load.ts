/**
 * `loadKeys` — the on-demand, version-stamped snapshot loader.
 *
 * Loads only the requested config keys, fetching just the ones not already
 * resolved at the current settings version (one `WHERE key IN (...)` query) and
 * decrypting only those. When the shared version has moved since the cache was
 * stamped, the whole cache is discarded and the requested keys are reloaded.
 *
 * `invalidateCache` is the full reset — drops the raw cache AND resets the
 * snapshot to defaults. It is registered as the settings-table invalidation
 * hook so any write through the db client (rare in production, common in
 * tests) puts the next reader back on a clean footing.
 */

import { queryAll } from "#db/client.ts";
import { applyKeys } from "#db/settings/apply.ts";
import {
  currentVersion,
  getCacheState,
  invalidateVersionProbe,
  resetCache,
  setCacheState,
  settingsReadRefill,
} from "#db/settings/cache.ts";
import {
  defaults,
  type SettingsData,
  setSnapshotField,
} from "#db/settings/snapshot.ts";
import { recordSettingsLoaded } from "#db/settings-audit.ts";
import { unique } from "#fp";
import {
  type CacheInvalidation,
  registerTableInvalidation,
} from "#shared/cache-registry.ts";

/**
 * Load only the given config keys, fetching just the ones not already resolved
 * at the current settings version (one `WHERE key IN (...)` query) and
 * decrypting only those. When the shared version has moved since the cache was
 * stamped, the whole cache is discarded and the requested keys are reloaded.
 */
export const loadKeys = async (keys: readonly string[]): Promise<void> => {
  // Record everything declared this request, regardless of cache state, so the
  // read audit compares against the full declared set (not just cache misses).
  recordSettingsLoaded(keys);
  const version = await currentVersion();
  const cached = getCacheState();
  const s = cached.version === version ? cached : resetCache(version);
  const missing = unique([...keys]).filter((k) => !s.loaded.has(k));
  if (missing.length === 0) return;
  const rows = await settingsReadRefill.fetch(() =>
    queryAll<{ key: string; value: string }>(
      `SELECT key, value FROM settings WHERE key IN (${missing
        .map(() => "?")
        .join(", ")})`,
      missing,
    ),
  );
  for (const row of rows) s.values.set(row.key, row.value);
  await applyKeys(missing, s.values);
  for (const key of missing) s.loaded.add(key);
};

/** Full invalidation — clears raw cache AND resets snapshot to defaults. */
export const invalidateCache = (cause: CacheInvalidation = "manual"): void => {
  invalidateVersionProbe(cause);
  setCacheState(null);
  for (const key of Object.keys(defaults) as (keyof SettingsData)[]) {
    setSnapshotField(key, defaults[key]);
  }
};

registerTableInvalidation(["settings"], invalidateCache);
