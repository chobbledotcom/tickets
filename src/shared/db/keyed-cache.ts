/**
 * Isolate-level cache for a small entity table, keyed for O(1) lookup by a
 * numeric id and by a secondary string key (a blind index such as `slug_index`
 * or `username_index`), with a separate ordered view for "all rows" pages.
 *
 * Generalised from the listings cache so listings, groups and users share one
 * implementation. Record reads (`getByIds` / `getByKeys`)
 * fetch only the rows they need; `getAll` loads the whole set and warms the
 * dictionaries. Each entry carries its own expiry (`ttlMs`); a whole-list load
 * stamps every entry, a single-record load stamps only what it fetched.
 *
 * Writes invalidate immediately within the isolate. Refills use the primary
 * during the replica catch-up window, so a stale replica result cannot replace
 * the cleared data. Security gating (capacity, session validity) is enforced
 * against the database, not this cache.
 *
 * A generation counter (bumped by `invalidate`) drops any fetch that was in
 * flight when an invalidation landed, so a write can never be overwritten by a
 * read that started before it.
 */

/* jscpd:ignore-start -- imports */
import { lazyRef, ttlCache, unique } from "#fp";
import type { CacheInvalidation } from "#shared/cache-registry.ts";
import { createPrimaryCacheRefill } from "#shared/db/primary-reads.ts";
import { nowMs } from "#shared/now.ts";

/* jscpd:ignore-end */

/** Reads over a keyed entity cache. */
export type KeyedCache<T> = {
  getAll: () => Promise<T[]>;
  getById: (id: number) => Promise<T | null>;
  getByIds: (ids: number[]) => Promise<(T | null)[]>;
  getByKey: (key: string) => Promise<T | null>;
  getByKeys: (keys: string[]) => Promise<(T | null)[]>;
  invalidate: (cause?: CacheInvalidation) => void;
  size: () => number;
};

/** How a keyed cache identifies and loads its rows. */
export type KeyedCacheConfig<T> = {
  /** Primary numeric id of a row (listing / group / user id). */
  idOf: (row: T) => number;
  /** Secondary string key of a row (slug_index / username_index). */
  keyOf: (row: T) => string;
  /** Load every row, in display order. */
  fetchAll: () => Promise<T[]>;
  /**
   * Load rows by id. Provide it for large tables so id reads fetch and decrypt
   * only those rows; omit it for small tables, where `getByIds`
   * instead scans the whole-set load — fewer queries, no extra single-row SQL.
   */
  fetchByIds?: (ids: number[]) => Promise<T[]>;
  /**
   * Load rows by secondary key in one query (only those that exist). Provide it
   * for large tables; omit it for small tables, where `getByKeys`
   * scan the whole-set load instead.
   */
  fetchByKeys?: (keys: string[]) => Promise<T[]>;
  /** Entry lifetime in milliseconds. */
  ttlMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
};

export const createKeyedCache = <T>(
  config: KeyedCacheConfig<T>,
): KeyedCache<T> => {
  const { idOf, keyOf, fetchAll, fetchByIds, fetchByKeys, ttlMs } = config;
  const now = config.now ?? nowMs;
  const byId = ttlCache<number, T>(ttlMs, now);
  const byKey = ttlCache<string, T>(ttlMs, now);
  // The ordered whole-list snapshot and when it was loaded; null until a getAll
  // triggers a full load. Tracked apart from the dictionaries because
  // single-record loads must NOT mark the set complete.
  const [getFull, setFull] = lazyRef<{
    ordered: T[];
    loadedAt: number;
  } | null>(() => null);
  let generation = 0;
  const primaryRefill = createPrimaryCacheRefill(now);

  // Index a freshly-loaded row into both dictionaries — unless an invalidation
  // raced the fetch (generation moved), in which case the row may predate a
  // write, so it is handed back to this caller but not cached.
  const remember = (gen: number, row: T): T => {
    if (gen === generation) {
      byId.set(idOf(row), row);
      byKey.set(keyOf(row), row);
    }
    return row;
  };

  const loadFull = async (): Promise<T[]> => {
    const gen = generation;
    const ordered = await primaryRefill.fetch(fetchAll);
    if (gen === generation) {
      for (const row of ordered) remember(gen, row);
      setFull({ loadedAt: now(), ordered });
    }
    return ordered;
  };

  const getAll = (): Promise<T[]> => {
    const full = getFull();
    if (full && now() - full.loadedAt < ttlMs) {
      return Promise.resolve(full.ordered);
    }
    return loadFull();
  };

  const resolveMany = async <Key>(
    keys: Key[],
    cache: { get: (key: Key) => T | undefined },
    fetchRows: ((keys: Key[]) => Promise<T[]>) | undefined,
    keyOfRow: (row: T) => Key,
  ): Promise<(T | null)[]> => {
    const loaded = new Map<Key, T>();
    if (fetchRows) {
      const missing = unique(keys).filter((key) => !cache.get(key));
      if (missing.length > 0) {
        const gen = generation;
        const rows = await primaryRefill.fetch(() => fetchRows(missing));
        for (const row of rows) {
          loaded.set(keyOfRow(row), remember(gen, row));
        }
      }
    } else {
      await getAll();
    }
    return keys.map((key) => cache.get(key) ?? loaded.get(key) ?? null);
  };

  const getByIds = (ids: number[]): Promise<(T | null)[]> =>
    resolveMany(ids, byId, fetchByIds, idOf);

  const getById = async (id: number): Promise<T | null> =>
    (await getByIds([id]))[0] ?? null;

  // Resolve a batch of secondary keys, fetching only the misses in one query,
  // so a caller never loads more rows than it asked for. Small tables omit
  // fetchByKeys and instead resolve against the whole-set load.
  const getByKeys = (keys: string[]): Promise<(T | null)[]> =>
    resolveMany(keys, byKey, fetchByKeys, keyOf);

  const getByKey = async (key: string): Promise<T | null> =>
    (await getByKeys([key]))[0] ?? null;

  return {
    getAll,
    getById,
    getByIds,
    getByKey,
    getByKeys,
    invalidate: (cause = "manual") => {
      generation++;
      primaryRefill.afterInvalidation(cause === "write");
      byId.clear();
      byKey.clear();
      setFull(null);
    },
    size: () => byId.size(),
  };
};
