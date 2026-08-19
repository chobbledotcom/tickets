import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { holidays } from "#db/holidays.ts";
import { mustReadFromPrimary } from "#db/primary-reads.ts";
import { getAllCacheStats, registerCache } from "#shared/cache-registry.ts";
import { requestCache, runWithRequestCache } from "#shared/request-cache.ts";
import { describeWithEnv } from "#test-utils/db.ts";

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

  test("refills from primary across requests while replicas catch up", async () => {
    const reads: boolean[] = [];
    const cache = requestCache(() => {
      reads.push(mustReadFromPrimary());
      return Promise.resolve([reads.length]);
    });

    cache.invalidate("write");
    await runWithRequestCache(() => cache.getAll());
    await runWithRequestCache(() => cache.getAll());

    expect(reads).toEqual([true, true]);
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

  test("reads that inherit a finished request's context fetch fresh", async () => {
    // A continuation registered inside a request keeps the request's async
    // context when it runs later — the runtime can hand that context to work
    // that starts long after the request finished (observed after a forced GC
    // at a test boundary). Such reads must behave as "outside a request":
    // fetch fresh, never serve the dead request's memoised data.
    const { cache, getCalls } = makeCountingCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let afterRequest!: Promise<number>;
    await runWithRequestCache(async () => {
      await cache.getAll(); // memoised for this request (1 fetch)
      afterRequest = (async () => {
        await gate;
        await cache.getAll();
        await cache.getAll();
        return getCalls();
      })();
    });
    release();
    // Two uncached fetches after the request ended: 1 (in-request) + 2.
    expect(await afterRequest).toBe(3);
  });

  test("concurrent reads within request share one fetch", async () => {
    const { cache, getCalls } = makeCountingCache();

    await runWithRequestCache(async () => {
      const [a, b] = await Promise.all([cache.getAll(), cache.getAll()]);
      expect(a).toBe(b); // same reference
      expect(getCalls()).toBe(1);
    });
  });

  test("a failed fetch is not cached: the next read fetches fresh", async () => {
    // The cold-boot path prefetches the settings version before the schema
    // state check, so the first fetch can legitimately fail (fresh install).
    // A cached failure — or worse, a never-resolving placeholder — would
    // wedge every later read in the request.
    let calls = 0;
    const cache = requestCache(() => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("no such table: settings"))
        : Promise.resolve([calls]);
    });

    await runWithRequestCache(async () => {
      await expect(cache.getAll()).rejects.toThrow("no such table");
      expect(await cache.getAll()).toEqual([2]);
      expect(calls).toBe(2);
    });
  });

  test("concurrent reads sharing a failed fetch all receive the failure", async () => {
    let calls = 0;
    const cache = requestCache(() => {
      calls++;
      return Promise.reject(new Error(`boom ${calls}`));
    });

    await runWithRequestCache(async () => {
      const [a, b] = await Promise.allSettled([cache.getAll(), cache.getAll()]);
      expect(a.status).toBe("rejected");
      expect(b.status).toBe("rejected");
      // Both readers shared the single in-flight fetch.
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
    await holidays.table.insert({
      endDate: "2026-07-31",
      name: "Summer Break",
      startDate: "2026-07-01",
    });

    // Within a request, same data is returned (cached reference)
    await runWithRequestCache(async () => {
      const first = await holidays.getAll();
      const second = await holidays.getAll();
      expect(first).toBe(second); // same reference = cached
      expect(first).toHaveLength(1);
      expect(first[0]!.name).toBe("Summer Break");
    });
  });

  test("each request gets fresh data after writes", async () => {
    const first = await runWithRequestCache(() => holidays.getAll());
    expect(first).toHaveLength(0);

    await holidays.table.insert({
      endDate: "2026-12-31",
      name: "Winter Break",
      startDate: "2026-12-20",
    });

    const second = await runWithRequestCache(() => holidays.getAll());
    expect(second).toHaveLength(1);
    expect(second[0]!.name).toBe("Winter Break");
  });

  test("cache-registry collects stats from request caches", async () => {
    const cache = requestCache(() => Promise.resolve([1, 2, 3]));
    const unregister = registerCache(() => ({
      entries: cache.size(),
      name: "test-integration",
    }));

    try {
      await runWithRequestCache(async () => {
        await cache.getAll();
        const stats = getAllCacheStats();
        const testStat = stats.find((s) => s.name === "test-integration");
        expect(testStat).toBeDefined();
        expect(testStat!.entries).toBe(3);
      });
    } finally {
      unregister();
    }
  });
});
