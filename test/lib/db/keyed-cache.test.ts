import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  createKeyedCache,
  type KeyedCache,
  type KeyedCacheConfig,
} from "#shared/db/keyed-cache.ts";

/** A minimal cached row: a numeric id and a secondary string key. */
type Row = { id: number; key: string };
const row = (id: number): Row => ({ id, key: `k${id}` });

/** A fake backing store plus call counters, so each test can assert exactly how
 * many round-trips the cache made and for which records. */
const makeFetchers = (rows: Row[]) => {
  const store = new Map(rows.map((r) => [r.id, r]));
  const calls = { all: 0, byId: [] as number[], byKeys: [] as string[][] };
  const base: Omit<KeyedCacheConfig<Row>, "ttlMs" | "now"> = {
    fetchAll: () => {
      calls.all++;
      return Promise.resolve([...store.values()]);
    },
    fetchById: (id) => {
      calls.byId.push(id);
      return Promise.resolve(store.get(id) ?? null);
    },
    fetchByKeys: (keys) => {
      calls.byKeys.push(keys);
      const set = new Set(keys);
      return Promise.resolve([...store.values()].filter((r) => set.has(r.key)));
    },
    idOf: (r) => r.id,
    keyOf: (r) => r.key,
  };
  return { base, calls, store };
};

describe("db > keyed-cache", () => {
  let clock: number;
  const now = (): number => clock;
  beforeEach(() => {
    clock = 1000;
  });

  type CacheFixture = {
    cache: KeyedCache<Row>;
    calls: ReturnType<typeof makeFetchers>["calls"];
  };

  const build = (rows: Row[]): CacheFixture => {
    const { base, calls } = makeFetchers(rows);
    return { cache: createKeyedCache({ ...base, now, ttlMs: 1000 }), calls };
  };

  // A "small table" cache that omits the single-row fetchers, so by-id and
  // by-key reads fall back to the whole-set load.
  const buildLite = (rows: Row[]): CacheFixture => {
    const { base, calls } = makeFetchers(rows);
    return {
      cache: createKeyedCache<Row>({
        fetchAll: base.fetchAll,
        idOf: base.idOf,
        keyOf: base.keyOf,
        now,
        ttlMs: 1000,
      }),
      calls,
    };
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

  test("getByKey fetches by key, then serves from cache, without loading all", async () => {
    const { cache, calls } = build([row(1), row(2)]);
    expect((await cache.getByKey("k2"))?.id).toBe(2);
    expect((await cache.getByKey("k2"))?.id).toBe(2);
    expect(calls.all).toBe(0);
    expect(calls.byKeys).toEqual([["k2"]]); // one fetch, then cached
  });

  test("getByKey returns null for a missing key", async () => {
    const { cache } = build([row(1)]);
    expect(await cache.getByKey("nope")).toBeNull();
  });

  test("getByKeys batches only the misses and preserves input order", async () => {
    const { cache, calls } = build([row(1), row(2), row(3)]);
    await cache.getByKey("k2"); // warm one entry
    const result = await cache.getByKeys(["k1", "k2", "k3", "missing"]);
    expect(result.map((r) => r?.id ?? null)).toEqual([1, 2, 3, null]);
    // First call fetched k2; the batch then fetches only the uncached keys.
    expect(calls.byKeys).toEqual([["k2"], ["k1", "k3", "missing"]]);
  });

  test("getByKeys makes no query when every key is already cached", async () => {
    const { cache, calls } = build([row(1)]);
    await cache.getByKey("k1");
    const result = await cache.getByKeys(["k1", "k1"]);
    expect(result.map((r) => r?.id)).toEqual([1, 1]);
    expect(calls.byKeys).toEqual([["k1"]]); // only the warming fetch
  });

  test("without fetchById, getById resolves against the whole-set load", async () => {
    const { cache, calls } = buildLite([row(1), row(2)]);
    expect((await cache.getById(2))?.id).toBe(2);
    expect(await cache.getById(99)).toBeNull();
    expect(calls.byId).toEqual([]); // single-row fetcher never used
    expect(calls.all).toBe(1); // one whole-set load, reused for both reads
  });

  test("without fetchByKeys, getByKey/getByKeys resolve against the whole-set load", async () => {
    const { cache, calls } = buildLite([row(1), row(2)]);
    expect((await cache.getByKey("k1"))?.id).toBe(1);
    const many = await cache.getByKeys(["k2", "missing"]);
    expect(many.map((r) => r?.id ?? null)).toEqual([2, null]);
    expect(calls.byKeys).toEqual([]); // batch fetcher never used
  });

  test("getAll loads the whole set once, then serves it within the TTL", async () => {
    const { cache, calls } = build([row(1), row(2)]);
    expect((await cache.getAll()).map((r) => r.id)).toEqual([1, 2]);
    await cache.getAll();
    expect(calls.all).toBe(1);
  });

  test("getAll reloads the whole set once it expires", async () => {
    const { cache, calls } = build([row(1)]);
    await cache.getAll();
    clock += 1001;
    await cache.getAll();
    expect(calls.all).toBe(2);
  });

  test("a whole-set load warms by-id and by-key reads so they need no query", async () => {
    const { cache, calls } = build([row(1), row(2)]);
    await cache.getAll();
    expect((await cache.getById(2))?.id).toBe(2);
    expect((await cache.getByKey("k1"))?.id).toBe(1);
    expect(calls.byId).toEqual([]);
    expect(calls.byKeys).toEqual([]);
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
    let release!: (r: Row | null) => void;
    const { base } = makeFetchers([]);
    const cache = createKeyedCache<Row>({
      ...base,
      fetchById: () =>
        new Promise<Row | null>((r) => {
          release = r;
        }),
      now,
      ttlMs: 1000,
    });

    const inflight = cache.getById(1);
    cache.invalidate(); // lands while the fetch is pending
    release(row(1));
    expect((await inflight)?.id).toBe(1); // caller still gets the row
    expect(cache.size()).toBe(0); // but it was not cached
  });

  test("a whole-set load racing an invalidation is returned but not cached", async () => {
    let release!: (r: Row[]) => void;
    const { base } = makeFetchers([]);
    const cache = createKeyedCache<Row>({
      ...base,
      fetchAll: () =>
        new Promise<Row[]>((r) => {
          release = r;
        }),
      now,
      ttlMs: 1000,
    });

    const inflight = cache.getAll();
    cache.invalidate();
    release([row(1)]);
    expect((await inflight).map((r) => r.id)).toEqual([1]); // caller gets the data
    expect(cache.size()).toBe(0); // snapshot was discarded
  });

  test("defaults the clock to wall time when none is injected", async () => {
    const { base, calls } = makeFetchers([row(1)]);
    const cache = createKeyedCache<Row>({ ...base, ttlMs: 60_000 });
    await cache.getById(1);
    await cache.getById(1); // well within the TTL on the real clock
    expect(calls.byId).toEqual([1]);
  });
});
