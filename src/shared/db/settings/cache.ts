/**
 * Raw-row cache + cross-isolate version stamp.
 *
 * `values` holds the raw DB rows loaded so far (still sealed when encrypted —
 * decryption happens only when a value is resolved into the snapshot). `loaded`
 * records which keys have been resolved — present *or* absent in the DB — so a
 * partial `loadKeys` never re-queries a key it has already fetched. `version`
 * is the `settings_version` counter the rows were loaded at; `-1` means never
 * loaded.
 *
 * Freshness is decided by the version stamp, not a wall-clock TTL. Every
 * settings write bumps the shared `settings_version` counter in the DB
 * (`bumpSettingsVersion`), and each request probes that counter once
 * (the version probe). When the probed counter differs from the cache's
 * stamp, some isolate changed a setting and the cache reloads; otherwise it is
 * served as-is. This makes a change saved on one (warm) edge isolate visible
 * to every other isolate on its very next request — rather than lingering
 * until a TTL lapsed or the isolate restarted — while still skipping the
 * reload (and the decryption) entirely on the common no-change path.
 */

import { lazyRef } from "#fp";
import { registerCache } from "#shared/cache-registry.ts";
import {
  executeWithoutCacheInvalidation,
  queryAll,
} from "#shared/db/client.ts";
import { recordSettingRead } from "#shared/db/settings-audit.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { requestCache } from "#shared/request-cache.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

export type CacheState = {
  values: Map<string, string>;
  loaded: Set<string>;
  version: number;
};

const [getCacheState, setCacheState] = lazyRef<CacheState>(() => ({
  loaded: new Set(),
  values: new Map(),
  version: -1,
}));

registerCache(() => ({
  entries: getCacheState().values.size,
  name: "settings",
}));

export { getCacheState, setCacheState };

/**
 * Read the current `settings_version` counter straight from the DB (bypassing
 * the snapshot and the read audit — it is cache machinery, not an app setting).
 * The row is an integer once any write has created it; before the first write
 * (a fresh database) it is absent, which reads as version 0.
 */
export const getCurrentSettingsVersion = async (): Promise<number> => {
  const rows = await queryAll<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [CONFIG_KEYS.SETTINGS_VERSION],
  );
  return Number.parseInt(rows[0]?.value ?? "0", 10);
};

/**
 * Per-request memoised probe of the version counter. Inside a request the first
 * read is shared by every later `loadKeys` (one tiny query per request);
 * outside a request (tests, boot, CLI) each call probes fresh. Kicking it off
 * early (`prefetchVersion`) lets it overlap the rest of request setup.
 */
const versionProbe = requestCache<number>(async () => [
  await getCurrentSettingsVersion(),
]);

/** The settings version this request should be validated against. */
export const currentVersion = async (): Promise<number> =>
  (await versionProbe.getAll())[0]!;

/** Start fetching the settings version as early as possible in a request, so
 *  the tiny query overlaps the rest of request setup; loadKeys awaits it. */
export const prefetchVersion = (): void => {
  // Fired before the schema state check, which may legitimately find the
  // database not ready (fresh install) — drop the failure here; loadKeys
  // re-fetches and surfaces any real error on its own await. Registered as
  // pending work so a request that never reaches loadKeys (e.g. the
  // not-activated page) still settles the probe before responding — Bunny
  // kills fetches that outlive the response.
  addPendingWork(versionProbe.getAll().catch(() => {}));
};

/**
 * Atomically increment the shared `settings_version` counter. Every settings
 * write calls this so other isolates notice the change on their next request.
 * It bypasses cache invalidation (the writer maintains its cache in-place)
 * and, crucially, does not recurse through `writeRaw`, so a bump never bumps
 * again.
 */
export const bumpSettingsVersion = async (): Promise<void> => {
  await executeWithoutCacheInvalidation(
    "INSERT INTO settings (key, value) VALUES (?, '1') " +
      "ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
    [CONFIG_KEYS.SETTINGS_VERSION],
  );
};

/** Read a raw string from the cache. Returns null if missing or cache not loaded. */
export const getRawCached = (key: string): string | null => {
  recordSettingRead(key);
  return getCacheState().values.get(key) ?? null;
};

/**
 * Mutate the in-memory raw cache in place. The version stamp (not this write)
 * decides whether the cache is reused on the next load, so applying the value
 * we just wrote is always safe — it keeps the rest of this request's reads
 * consistent without forcing a reload.
 */
export const syncCache = (mutate: (state: CacheState) => void): void =>
  mutate(getCacheState());

/** Reset the raw cache to a fresh, empty state stamped at `version`. */
export const resetCache = (version: number): CacheState => {
  setCacheState(null);
  const s = getCacheState();
  s.version = version;
  return s;
};
