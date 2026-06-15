/**
 * Isolate-level cache for listings, keyed for O(1) lookup by id and by
 * slug_index, with a separate ordered view for "all listings" pages.
 *
 * Why this exists: serving one public listing (by slug) used to load and
 * decrypt EVERY listing, because the cache only ever exposed the whole list.
 * Here, by-id / by-slug reads fetch and cache just the one row they need, so
 * the decrypt-all cost is only paid when a caller genuinely needs every
 * listing (getAll / getByType — e.g. the admin calendar). We never fetch more
 * records than are strictly needed.
 *
 * Freshness: every cached entry carries its own expiry (LISTINGS_CACHE_TTL_MS).
 * A whole-list load stamps every entry; a single-listing refresh stamps only
 * that one entry. Staleness is bounded and display-only — capacity is enforced
 * atomically in SQL on every write (see attendees/capacity.ts) and local writes
 * invalidate immediately, so a stale snapshot can never overbook; it can only
 * show a slightly out-of-date count/availability for up to the TTL.
 *
 * A generation counter (bumped by invalidate) drops any fetch that was already
 * in flight when an invalidation landed, so a write can never be overwritten by
 * a read that started before it.
 */

import { lazyRef, ttlCache } from "#fp";
import { nowMs } from "#shared/now.ts";
import type { ListingType, ListingWithCount } from "#shared/types.ts";

/** How long a cached listing entry is served before it is re-fetched. */
export const LISTINGS_CACHE_TTL_MS = 30_000;

/** A listings cache: single-record reads by id/slug, plus whole-list views. */
export type ListingsCache = {
  getAll: () => Promise<ListingWithCount[]>;
  getById: (id: number) => Promise<ListingWithCount | null>;
  getBySlugIndex: (slugIndex: string) => Promise<ListingWithCount | null>;
  getBySlugIndexes: (
    slugIndexes: string[],
  ) => Promise<(ListingWithCount | null)[]>;
  getByType: (type: ListingType) => Promise<ListingWithCount[]>;
  invalidate: () => void;
  size: () => number;
};

/** Data sources the cache pulls from when an entry is missing or expired. */
export type ListingsCacheFetchers = {
  /** Every listing with its count, in display order (newest first). */
  fetchAll: () => Promise<ListingWithCount[]>;
  /** One listing by id, or null when it does not exist. */
  fetchById: (id: number) => Promise<ListingWithCount | null>;
  /** One listing by slug_index, or null when it does not exist. */
  fetchBySlugIndex: (slugIndex: string) => Promise<ListingWithCount | null>;
  /** Several listings by slug_index in one query (only the rows that exist). */
  fetchBySlugIndexes: (slugIndexes: string[]) => Promise<ListingWithCount[]>;
};

export const createListingsCache = (
  fetchers: ListingsCacheFetchers,
  ttlMs: number = LISTINGS_CACHE_TTL_MS,
  now: () => number = nowMs,
): ListingsCache => {
  const byId = ttlCache<number, ListingWithCount>(ttlMs, now);
  const bySlugIndex = ttlCache<string, ListingWithCount>(ttlMs, now);
  // The ordered whole-list snapshot and when it was loaded; null until a
  // getAll/getByType triggers a full load. Tracked apart from the per-entry
  // dictionaries because single-record loads must NOT mark the set complete.
  const [getFull, setFull] = lazyRef<{
    ordered: ListingWithCount[];
    loadedAt: number;
  } | null>(() => null);
  let generation = 0;

  // Index a freshly-loaded listing into both dictionaries — unless an
  // invalidation raced the fetch (generation moved), in which case the row may
  // predate a write, so it is handed back to this caller but not cached.
  const remember = (
    gen: number,
    listing: ListingWithCount,
  ): ListingWithCount => {
    if (gen === generation) {
      byId.set(listing.id, listing);
      bySlugIndex.set(listing.slug_index, listing);
    }
    return listing;
  };

  const loadOne = async <K>(
    key: K,
    dict: { get: (k: K) => ListingWithCount | undefined },
    fetchOne: (k: K) => Promise<ListingWithCount | null>,
  ): Promise<ListingWithCount | null> => {
    const cached = dict.get(key);
    if (cached) return cached;
    const gen = generation;
    const listing = await fetchOne(key);
    return listing ? remember(gen, listing) : null;
  };

  const loadFull = async (): Promise<ListingWithCount[]> => {
    const gen = generation;
    const ordered = await fetchers.fetchAll();
    if (gen === generation) {
      for (const listing of ordered) remember(gen, listing);
      setFull({ loadedAt: now(), ordered });
    }
    return ordered;
  };

  const ensureFull = (): Promise<ListingWithCount[]> => {
    const full = getFull();
    if (full && now() - full.loadedAt < ttlMs) {
      return Promise.resolve(full.ordered);
    }
    return loadFull();
  };

  // Resolve a batch of slug indexes against the cache, fetching only the
  // misses — in a single query — so a multi-listing page never loads more
  // records than it asked for.
  const getBySlugIndexes = async (
    slugIndexes: string[],
  ): Promise<(ListingWithCount | null)[]> => {
    const missing = [...new Set(slugIndexes)].filter(
      (idx) => !bySlugIndex.get(idx),
    );
    if (missing.length > 0) {
      const gen = generation;
      const fetched = await fetchers.fetchBySlugIndexes(missing);
      for (const listing of fetched) remember(gen, listing);
    }
    return slugIndexes.map((idx) => bySlugIndex.get(idx) ?? null);
  };

  return {
    getAll: ensureFull,
    getById: (id) => loadOne(id, byId, fetchers.fetchById),
    getBySlugIndex: (idx) =>
      loadOne(idx, bySlugIndex, fetchers.fetchBySlugIndex),
    getBySlugIndexes,
    getByType: async (type) =>
      (await ensureFull()).filter((e) => e.listing_type === type),
    invalidate: () => {
      generation++;
      byId.clear();
      bySlugIndex.clear();
      setFull(null);
    },
    size: () => byId.size(),
  };
};
