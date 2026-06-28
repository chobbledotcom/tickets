import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  getAllCacheStats,
  invalidateCachesForTable,
  invalidateCachesForWrite,
  registerCache,
  registerDependencies,
  registerTableInvalidation,
  resetCacheRegistry,
  type WriteVerb,
} from "#shared/cache-registry.ts";
import { getAllHolidays, holidaysTable } from "#shared/db/holidays.ts";
import { requestCache, runWithRequestCache } from "#shared/request-cache.ts";
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
    registerCache(() => ({ entries: 5, name: "test" }));
    const stats = getAllCacheStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]!.name).toBe("test");
    expect(stats[0]!.entries).toBe(5);
  });

  test("supports capacity field", () => {
    registerCache(() => ({ capacity: 10000, entries: 100, name: "lru" }));
    const stats = getAllCacheStats();
    expect(stats[0]!.capacity).toBe(10000);
  });

  test("collects stats from multiple caches", () => {
    registerCache(() => ({ entries: 1, name: "a" }));
    registerCache(() => ({ entries: 2, name: "b" }));
    registerCache(() => ({ entries: 3, name: "c" }));
    const stats = getAllCacheStats();
    expect(stats).toHaveLength(3);
  });

  test("calls providers each time to get fresh stats", () => {
    let count = 0;
    registerCache(() => ({ entries: ++count, name: "dynamic" }));
    expect(getAllCacheStats()[0]!.entries).toBe(1);
    expect(getAllCacheStats()[0]!.entries).toBe(2);
  });

  test("resetCacheRegistry clears all providers", () => {
    registerCache(() => ({ entries: 1, name: "test" }));
    expect(getAllCacheStats()).toHaveLength(1);
    resetCacheRegistry();
    expect(getAllCacheStats()).toHaveLength(0);
  });
});

describe("table invalidation registry", () => {
  beforeEach(() => {
    resetCacheRegistry();
  });

  afterEach(() => {
    resetCacheRegistry();
  });

  test("fires the invalidator registered for a written table", () => {
    let fired = 0;
    registerTableInvalidation(["listings"], () => {
      fired++;
    });
    invalidateCachesForTable("listings");
    expect(fired).toBe(1);
  });

  test("ignores tables with no registered invalidator", () => {
    let fired = 0;
    registerTableInvalidation(["listings"], () => {
      fired++;
    });
    invalidateCachesForTable("sessions");
    expect(fired).toBe(0);
  });

  test("one invalidator can depend on several tables", () => {
    let fired = 0;
    registerTableInvalidation(["listings", "listing_attendees"], () => {
      fired++;
    });
    invalidateCachesForTable("listing_attendees");
    expect(fired).toBe(1);
  });

  test("fires every invalidator registered against the same table", () => {
    let a = 0;
    let b = 0;
    registerTableInvalidation(["users"], () => {
      a++;
    });
    registerTableInvalidation(["users"], () => {
      b++;
    });
    invalidateCachesForTable("users");
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("resetCacheRegistry clears table invalidators", () => {
    let fired = 0;
    registerTableInvalidation(["listings"], () => {
      fired++;
    });
    resetCacheRegistry();
    invalidateCachesForTable("listings");
    expect(fired).toBe(0);
  });
});

describe("column-gated invalidation", () => {
  beforeEach(() => {
    resetCacheRegistry();
  });

  afterEach(() => {
    resetCacheRegistry();
  });

  /** Register a column-gated (or ungated) invalidation on `table`, fire a
   *  write, and assert the callback fires `expected` times. Colsapses the
   *  shared `let fired = 0; registerTableInvalidation(…); invalidate(…);
   *  expect(fired).toBe(N)` scaffold every test in this block uses. */
  const expectGatedFire = (opts: {
    table?: string;
    whenColumns?: readonly string[];
    touchedColumns?: readonly string[];
    verb?: WriteVerb;
    useTableInvalidation?: boolean;
    expected: number;
  }): void => {
    const table = opts.table ?? "listing_attendees";
    let fired = 0;
    registerTableInvalidation(
      [table],
      () => {
        fired++;
      },
      opts.whenColumns ? { whenColumns: opts.whenColumns } : undefined,
    );
    if (opts.useTableInvalidation) {
      invalidateCachesForTable(table);
    } else {
      invalidateCachesForWrite(table, {
        columns: new Set(opts.touchedColumns ?? []),
        verb: opts.verb ?? "insert",
      });
    }
    expect(fired).toBe(opts.expected);
  };

  test("column-gated UPDATE fires when it touches a listed column", () => {
    expectGatedFire({
      expected: 1,
      touchedColumns: ["quantity"],
      verb: "update",
      whenColumns: ["quantity", "price_paid"],
    });
  });

  test("column-gated UPDATE does not fire when only other columns are touched", () => {
    expectGatedFire({
      expected: 0,
      touchedColumns: ["checked_in"],
      verb: "update",
      whenColumns: ["quantity", "price_paid"],
    });
  });

  test("column-gated dependency always fires for INSERT", () => {
    expectGatedFire({ expected: 1, verb: "insert", whenColumns: ["quantity"] });
  });

  test("column-gated dependency always fires for DELETE", () => {
    expectGatedFire({ expected: 1, verb: "delete", whenColumns: ["quantity"] });
  });

  test("column-gated dependency always fires for REPLACE", () => {
    expectGatedFire({
      expected: 1,
      verb: "replace",
      whenColumns: ["quantity"],
    });
  });

  test("ungated dependency fires for any UPDATE regardless of columns", () => {
    expectGatedFire({
      expected: 1,
      table: "users",
      touchedColumns: ["some_col"],
      verb: "update",
    });
  });

  test("fallback (INSERT verb) fires column-gated entries unconditionally", () => {
    expectGatedFire({ expected: 1, verb: "insert", whenColumns: ["quantity"] });
  });

  test("invalidateCachesForTable fires column-gated entries unconditionally", () => {
    expectGatedFire({
      expected: 1,
      useTableInvalidation: true,
      whenColumns: ["quantity"],
    });
  });

  test("registerDependencies wires a plain-string dep unconditionally", () => {
    let fired = 0;
    registerDependencies("own_table", ["other_table"], () => {
      fired++;
    });
    invalidateCachesForTable("other_table");
    expect(fired).toBe(1);
  });
});

describe("requestCache", () => {
  const makeCountingCache = () => {
    let calls = 0;
    const cache = requestCache(() => {
      calls++;
      return Promise.resolve([1, 2, 3]);
    });
    return { cache, getCalls: () => calls };
  };

  test("fetches on first call and caches within request", async () => {
    const { cache, getCalls } = makeCountingCache();

    await runWithRequestCache(async () => {
      const first = await cache.getAll();
      expect(first).toEqual([1, 2, 3]);
      const second = await cache.getAll();
      expect(second).toBe(first); // same reference
      expect(getCalls()).toBe(1);
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
    const { cache, getCalls } = makeCountingCache();

    await runWithRequestCache(async () => {
      const [a, b] = await Promise.all([cache.getAll(), cache.getAll()]);
      expect(a).toBe(b); // same reference
      expect(getCalls()).toBe(1);
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
      endDate: "2026-07-31",
      name: "Summer Break",
      startDate: "2026-07-01",
    });

    // Within a request, same data is returned (cached reference)
    await runWithRequestCache(async () => {
      const first = await getAllHolidays();
      const second = await getAllHolidays();
      expect(first).toBe(second); // same reference = cached
      expect(first).toHaveLength(1);
      expect(first[0]!.name).toBe("Summer Break");
    });
  });

  test("each request gets fresh data after writes", async () => {
    const first = await runWithRequestCache(() => getAllHolidays());
    expect(first).toHaveLength(0);

    await holidaysTable.insert({
      endDate: "2026-12-31",
      name: "Winter Break",
      startDate: "2026-12-20",
    });

    const second = await runWithRequestCache(() => getAllHolidays());
    expect(second).toHaveLength(1);
    expect(second[0]!.name).toBe("Winter Break");
  });

  test("cache-registry collects stats from request caches", async () => {
    const cache = requestCache(() => Promise.resolve([1, 2, 3]));
    registerCache(() => ({ entries: cache.size(), name: "test-integration" }));

    await runWithRequestCache(async () => {
      await cache.getAll();
      const stats = getAllCacheStats();
      const testStat = stats.find((s) => s.name === "test-integration");
      expect(testStat).toBeDefined();
      expect(testStat!.entries).toBe(3);
    });
  });
});
