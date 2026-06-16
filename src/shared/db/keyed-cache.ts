/**
 * Isolate-level cache for a small entity table, keyed for O(1) lookup by a
 * numeric id and by a secondary string key (a blind index such as `slug_index`
 * or `username_index`), with a separate ordered view for "all rows" pages.
 *
 * Generalised from the listings cache so listings, groups and users share one
 * implementation. Single-record reads (`getById` / `getByKey` / `getByKeys`)
 * fetch only the rows they need; `getAll` loads the whole set and warms the
 * dictionaries. Each entry carries its own expiry (`ttlMs`); a whole-list load
 * stamps every entry, a single-record load stamps only what it fetched.
 *
 * Staleness is bounded and never authoritative: writes invalidate immediately
 * within the isolate, and security gating (capacity, session validity) is
 * enforced against the database, not this cache — so a stale entry can only
 * show slightly out-of-date display data for up to the TTL across isolates.
 *
 * A generation counter (bumped by `invalidate`) drops any fetch that was in
 * flight when an invalidation landed, so a write can never be overwritten by a
 * read that started before it.
 */

import { lazyRef, ttlCache, unique } from "#fp";
import { nowMs } from "#shared/now.ts";

/** Reads over a keyed entity cache. */
export type KeyedCache<T> = {
  getAll: () => Promise<T[]>;
  getById: (id: number) => Promise<T | null>;
  getByKey: (key: string) => Promise<T | null>;
  getByKeys: (keys: string[]) => Promise<(T | null)[]>;
  invalidate: () => void;
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
   * Load one row by id. Provide it for large tables so a by-id read fetches
   * (and decrypts) only that row; omit it for small tables, where `getById`
   * instead scans the whole-set load — fewer queries, no extra single-row SQL.
   */
  fetchById?: (id: number) => Promise<T | null>;
  /**
   * Load rows by secondary key in one query (only those that exist). Provide it
   * for large tables; omit it for small tables, where `getByKey`/`getByKeys`
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
  const { idOf, keyOf, fetchAll, fetchById, fetchByKeys, ttlMs } = config;
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
    const ordered = await fetchAll();
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

  const getById = async (id: number): Promise<T | null> => {
    const cached = byId.get(id);
    if (cached) return cached;
    if (!fetchById) {
      await getAll(); // whole-set load warms byId
      return byId.get(id) ?? null;
    }
    const gen = generation;
    const row = await fetchById(id);
    return row ? remember(gen, row) : null;
  };

  // Resolve a batch of secondary keys, fetching only the misses in one query,
  // so a caller never loads more rows than it asked for. Small tables omit
  // fetchByKeys and instead resolve against the whole-set load.
  const getByKeys = async (keys: string[]): Promise<(T | null)[]> => {
    if (!fetchByKeys) {
      await getAll(); // whole-set load warms byKey
      return keys.map((k) => byKey.get(k) ?? null);
    }
    const missing = unique(keys).filter((k) => !byKey.get(k));
    if (missing.length > 0) {
      const gen = generation;
      const rows = await fetchByKeys(missing);
      for (const row of rows) remember(gen, row);
    }
    return keys.map((k) => byKey.get(k) ?? null);
  };

  const getByKey = async (key: string): Promise<T | null> =>
    (await getByKeys([key]))[0] ?? null;

  return {
    getAll,
    getById,
    getByKey,
    getByKeys,
    invalidate: () => {
      generation++;
      byId.clear();
      byKey.clear();
      setFull(null);
    },
    size: () => byId.size(),
  };
};
