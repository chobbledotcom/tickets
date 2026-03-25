import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  getAllCacheStats,
  registerCache,
  resetCacheRegistry,
} from "#lib/cache-registry.ts";
import { getAllHolidays, holidaysTable } from "#lib/db/holidays.ts";
import { requestCache, runWithRequestCache } from "#lib/request-cache.ts";
import { describeWithEnv } from "#test-utils";

describe("cache-registry", () => {
  beforeEach(() => {
    resetCacheRegistry();
  });

  afterEach(() => {
    resetCacheRegistry();
  });

  test("returns empty array when no caches registered", () => {
    expect(getAllCacheStats()).toEqual([]);
  });

  test("returns stats from registered caches", () => {
    registerCache(() => ({ name: "test", entries: 5 }));
    const stats = getAllCacheStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]?.name).toBe("test");
    expect(stats[0]?.entries).toBe(5);
  });

  test("supports capacity field", () => {
    registerCache(() => ({ name: "lru", entries: 100, capacity: 10000 }));
    const stats = getAllCacheStats();
    expect(stats[0]?.capacity).toBe(10000);
  });

  test("collects stats from multiple caches", () => {
    registerCache(() => ({ name: "a", entries: 1 }));
    registerCache(() => ({ name: "b", entries: 2 }));
    registerCache(() => ({ name: "c", entries: 3 }));
    const stats = getAllCacheStats();
    expect(stats).toHaveLength(3);
  });

  test("calls providers each time to get fresh stats", () => {
    let count = 0;
    registerCache(() => ({ name: "dynamic", entries: ++count }));
    expect(getAllCacheStats()[0]?.entries).toBe(1);
    expect(getAllCacheStats()[0]?.entries).toBe(2);
  });

  test("resetCacheRegistry clears all providers", () => {
    registerCache(() => ({ name: "test", entries: 1 }));
    expect(getAllCacheStats()).toHaveLength(1);
    resetCacheRegistry();
    expect(getAllCacheStats()).toHaveLength(0);
  });
});

describe("requestCache", () => {
  test("fetches on first call and caches within request", async () => {
    let calls = 0;
    const cache = requestCache(() => {
      calls++;
      return Promise.resolve([1, 2, 3]);
    });

    await runWithRequestCache(async () => {
      const first = await cache.getAll();
      expect(first).toEqual([1, 2, 3]);
      const second = await cache.getAll();
      expect(second).toBe(first); // same reference
      expect(calls).toBe(1);
    });
  });

  test("each request gets a fresh cache", async () => {
    let counter = 0;
    const cache = requestCache(() => Promise.resolve([++counter]));

    const first = await runWithRequestCache(() => cache.getAll());
    const second = await runWithRequestCache(() => cache.getAll());
    expect(first).toEqual([1]);
    expect(second).toEqual([2]);
  });

  test("invalidate clears cache within request", async () => {
    let counter = 0;
    const cache = requestCache(() => Promise.resolve([++counter]));

    await runWithRequestCache(async () => {
      expect(await cache.getAll()).toEqual([1]);
      cache.invalidate();
      expect(await cache.getAll()).toEqual([2]);
    });
  });

  test("fetches directly without request context", async () => {
    let calls = 0;
    const cache = requestCache(() => {
      calls++;
      return Promise.resolve([1, 2, 3]);
    });

    await cache.getAll();
    await cache.getAll();
    expect(calls).toBe(2); // no caching
  });

  test("concurrent reads within request share one fetch", async () => {
    let calls = 0;
    const cache = requestCache(() => {
      calls++;
      return Promise.resolve([1, 2, 3]);
    });

    await runWithRequestCache(async () => {
      const [a, b] = await Promise.all([cache.getAll(), cache.getAll()]);
      expect(a).toBe(b); // same reference
      expect(calls).toBe(1);
    });
  });

  test("size returns 0 before fetch and count after", async () => {
    const cache = requestCache(() => Promise.resolve([1, 2, 3]));

    await runWithRequestCache(async () => {
      expect(cache.size()).toBe(0);
      await cache.getAll();
      expect(cache.size()).toBe(3);
    });
  });

  test("size returns 0 after invalidate", async () => {
    const cache = requestCache(() => Promise.resolve([1, 2, 3]));

    await runWithRequestCache(async () => {
      await cache.getAll();
      expect(cache.size()).toBe(3);
      cache.invalidate();
      expect(cache.size()).toBe(0);
    });
  });

  test("size returns 0 without request context", () => {
    const cache = requestCache(() => Promise.resolve([1, 2, 3]));
    expect(cache.size()).toBe(0);
  });

  test("invalidate is safe without request context", () => {
    const cache = requestCache(() => Promise.resolve([1, 2, 3]));
    cache.invalidate(); // should not throw
  });

  test("multiple caches are independent", async () => {
    const cacheA = requestCache(() => Promise.resolve(["a"]));
    const cacheB = requestCache(() => Promise.resolve(["b"]));

    await runWithRequestCache(async () => {
      expect(await cacheA.getAll()).toEqual(["a"]);
      expect(await cacheB.getAll()).toEqual(["b"]);
      cacheA.invalidate();
      expect(cacheB.size()).toBe(1); // B unaffected
      expect(cacheA.size()).toBe(0); // A cleared
    });
  });
});

describeWithEnv("caching integration", { db: true }, () => {
  test("caches holidays within a request and serves fresh data across requests", async () => {
    await holidaysTable.insert({
      name: "Summer Break",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });

    // Within a request, same data is returned (cached reference)
    await runWithRequestCache(async () => {
      const first = await getAllHolidays();
      const second = await getAllHolidays();
      expect(first).toBe(second); // same reference = cached
      expect(first).toHaveLength(1);
      expect(first[0]?.name).toBe("Summer Break");
    });
  });

  test("each request gets fresh data after writes", async () => {
    const first = await runWithRequestCache(() => getAllHolidays());
    expect(first).toHaveLength(0);

    await holidaysTable.insert({
      name: "Winter Break",
      startDate: "2026-12-20",
      endDate: "2026-12-31",
    });

    const second = await runWithRequestCache(() => getAllHolidays());
    expect(second).toHaveLength(1);
    expect(second[0]?.name).toBe("Winter Break");
  });

  test("cache-registry collects stats from request caches", async () => {
    const cache = requestCache(() => Promise.resolve([1, 2, 3]));
    registerCache(() => ({ name: "test-integration", entries: cache.size() }));

    await runWithRequestCache(async () => {
      await cache.getAll();
      const stats = getAllCacheStats();
      const testStat = stats.find((s) => s.name === "test-integration");
      expect(testStat).toBeDefined();
      expect(testStat?.entries).toBe(3);
    });
  });
});
