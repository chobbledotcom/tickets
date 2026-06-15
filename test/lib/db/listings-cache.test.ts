import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  createListingsCache,
  LISTINGS_CACHE_TTL_MS,
  type ListingsCache,
  type ListingsCacheFetchers,
} from "#shared/db/listings-cache.ts";
import type { ListingType, ListingWithCount } from "#shared/types.ts";
import { testListingWithCount } from "#test-utils";

/** A listing row keyed for the fake data source. */
const row = (
  id: number,
  extra: Partial<ListingWithCount> = {},
): ListingWithCount =>
  testListingWithCount({ id, slug_index: `slug-${id}`, ...extra });

/**
 * A fake backing store plus call counters, so each test can assert exactly how
 * many DB round-trips the cache made and for which records.
 */
const makeFetchers = (rows: ListingWithCount[]) => {
  const store = new Map(rows.map((r) => [r.id, r]));
  const calls = { all: 0, byId: [] as number[], bySlug: [] as string[][] };
  const fetchers: ListingsCacheFetchers = {
    fetchAll: () => {
      calls.all++;
      return Promise.resolve([...store.values()]);
    },
    fetchById: (id) => {
      calls.byId.push(id);
      return Promise.resolve(store.get(id) ?? null);
    },
    fetchBySlugIndex: (slugIndex) => {
      const found = [...store.values()].find((r) => r.slug_index === slugIndex);
      return Promise.resolve(found ?? null);
    },
    fetchBySlugIndexes: (slugIndexes) => {
      calls.bySlug.push(slugIndexes);
      const set = new Set(slugIndexes);
      return Promise.resolve(
        [...store.values()].filter((r) => set.has(r.slug_index)),
      );
    },
  };
  return { calls, fetchers, store };
};

describe("db > listings-cache", () => {
  let clock: number;
  const now = (): number => clock;
  beforeEach(() => {
    clock = 1000;
  });

  const build = (
    rows: ListingWithCount[],
  ): {
    cache: ListingsCache;
    calls: ReturnType<typeof makeFetchers>["calls"];
  } => {
    const { calls, fetchers } = makeFetchers(rows);
    return { cache: createListingsCache(fetchers, 1000, now), calls };
  };

  test("getById fetches once, then serves from cache within the TTL", async () => {
    const { cache, calls } = build([row(1), row(2)]);
    expect((await cache.getById(1))?.id).toBe(1);
    expect((await cache.getById(1))?.id).toBe(1);
    expect(calls.byId).toEqual([1]);
  });

  test("getById re-fetches only that record once its entry expires", async () => {
    const { cache, calls } = build([row(1)]);
    await cache.getById(1);
    clock += 1001; // past the TTL
    await cache.getById(1);
    expect(calls.byId).toEqual([1, 1]);
  });

  test("getById returns null for a missing record and does not cache the miss", async () => {
    const { cache, calls } = build([row(1)]);
    expect(await cache.getById(99)).toBeNull();
    expect(await cache.getById(99)).toBeNull();
    expect(calls.byId).toEqual([99, 99]);
  });

  test("getBySlugIndex caches by slug and never loads the whole list", async () => {
    const { cache, calls } = build([row(1), row(2)]);
    expect((await cache.getBySlugIndex("slug-2"))?.id).toBe(2);
    expect((await cache.getBySlugIndex("slug-2"))?.id).toBe(2);
    expect(calls.all).toBe(0);
  });

  test("getBySlugIndexes batches only the misses and preserves input order", async () => {
    const { cache, calls } = build([row(1), row(2), row(3)]);
    await cache.getBySlugIndex("slug-2"); // warm one entry
    const result = await cache.getBySlugIndexes([
      "slug-1",
      "slug-2",
      "slug-3",
      "missing",
    ]);
    expect(result.map((r) => r?.id ?? null)).toEqual([1, 2, 3, null]);
    // Only the uncached slugs are fetched, in one batched call.
    expect(calls.bySlug).toEqual([["slug-1", "slug-3", "missing"]]);
  });

  test("getBySlugIndexes makes no query when every slug is already cached", async () => {
    const { cache, calls } = build([row(1)]);
    await cache.getBySlugIndex("slug-1");
    const result = await cache.getBySlugIndexes(["slug-1", "slug-1"]);
    expect(result.map((r) => r?.id)).toEqual([1, 1]);
    expect(calls.bySlug).toEqual([]);
  });

  test("getAll loads the whole list once, then serves it within the TTL", async () => {
    const { cache, calls } = build([row(1), row(2)]);
    expect((await cache.getAll()).map((r) => r.id)).toEqual([1, 2]);
    await cache.getAll();
    expect(calls.all).toBe(1);
  });

  test("getAll reloads the whole list once it expires", async () => {
    const { cache, calls } = build([row(1)]);
    await cache.getAll();
    clock += 1001;
    await cache.getAll();
    expect(calls.all).toBe(2);
  });

  test("a whole-list load warms by-id reads so they need no further query", async () => {
    const { cache, calls } = build([row(1), row(2)]);
    await cache.getAll();
    expect((await cache.getById(2))?.id).toBe(2);
    expect(calls.byId).toEqual([]); // served from the full load
  });

  test("getByType loads the list and filters by listing_type", async () => {
    const daily = row(1, { listing_type: "daily" as ListingType });
    const standard = row(2, { listing_type: "standard" as ListingType });
    const { cache } = build([daily, standard]);
    const result = await cache.getByType("daily" as ListingType);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  test("invalidate clears the full snapshot so the next getAll re-fetches", async () => {
    const { cache, calls } = build([row(1)]);
    await cache.getAll();
    cache.invalidate();
    await cache.getAll();
    expect(calls.all).toBe(2);
  });

  test("invalidate clears single-record entries so the next getById re-fetches", async () => {
    const { cache, calls } = build([row(1)]);
    await cache.getById(1);
    await cache.getById(1); // cached — no second fetch
    cache.invalidate();
    await cache.getById(1); // re-fetched
    expect(calls.byId).toEqual([1, 1]);
  });

  test("size reports the number of cached records", async () => {
    const { cache } = build([row(1), row(2)]);
    expect(cache.size()).toBe(0);
    await cache.getById(1);
    expect(cache.size()).toBe(1);
    await cache.getAll();
    expect(cache.size()).toBe(2);
  });

  test("a single-record fetch racing an invalidation is returned but not cached", async () => {
    // A controllable fetch lets us land an invalidate() between the fetch
    // starting and resolving — the in-flight row predates the write, so it must
    // be handed back to this caller but NOT installed into the cache.
    let release!: (r: ListingWithCount | null) => void;
    const fetchers: ListingsCacheFetchers = {
      fetchAll: () => Promise.resolve([]),
      fetchById: () =>
        new Promise<ListingWithCount | null>((r) => {
          release = r;
        }),
      fetchBySlugIndex: () => Promise.resolve(null),
      fetchBySlugIndexes: () => Promise.resolve([]),
    };
    const cache = createListingsCache(fetchers, 1000, now);

    const inflight = cache.getById(1);
    cache.invalidate(); // lands while the fetch is pending
    release(row(1));
    expect((await inflight)?.id).toBe(1); // caller still gets the row
    expect(cache.size()).toBe(0); // but it was not cached
  });

  test("a whole-list load racing an invalidation is returned but not cached", async () => {
    let release!: (r: ListingWithCount[]) => void;
    const fetchers: ListingsCacheFetchers = {
      fetchAll: () =>
        new Promise<ListingWithCount[]>((r) => {
          release = r;
        }),
      fetchById: () => Promise.resolve(null),
      fetchBySlugIndex: () => Promise.resolve(null),
      fetchBySlugIndexes: () => Promise.resolve([]),
    };
    const cache = createListingsCache(fetchers, 1000, now);

    const inflight = cache.getAll();
    cache.invalidate();
    release([row(1)]);
    expect((await inflight).map((r) => r.id)).toEqual([1]); // caller gets the data
    expect(cache.size()).toBe(0); // snapshot was discarded
  });

  test("defaults to the exported TTL constant", async () => {
    const { fetchers, calls } = makeFetchers([row(1)]);
    const cache = createListingsCache(fetchers); // real clock, default TTL
    await cache.getById(1);
    await cache.getById(1);
    expect(calls.byId).toEqual([1]); // second read well within LISTINGS_CACHE_TTL_MS
    expect(LISTINGS_CACHE_TTL_MS).toBeGreaterThan(0);
  });
});
