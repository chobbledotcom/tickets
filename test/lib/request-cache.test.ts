import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { requestCache, runWithRequestCache } from "#lib/request-cache.ts";

/** Create a tracked fetcher that counts calls */
const trackedFetcher = <T>(items: () => T[]) => {
  let calls = 0;
  const fetcher = () => {
    calls++;
    return Promise.resolve(items());
  };
  return { fetcher, getCalls: () => calls };
};

describe("requestCache", () => {
  test("fetches on first call and caches within request", async () => {
    const { fetcher, getCalls } = trackedFetcher(() => [1, 2, 3]);
    const cache = requestCache(fetcher);

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
    const fetcher = () => Promise.resolve([++counter]);
    const cache = requestCache(fetcher);

    const first = await runWithRequestCache(() => cache.getAll());
    const second = await runWithRequestCache(() => cache.getAll());
    expect(first).toEqual([1]);
    expect(second).toEqual([2]);
  });

  test("invalidate clears cache within request", async () => {
    let counter = 0;
    const fetcher = () => Promise.resolve([++counter]);
    const cache = requestCache(fetcher);

    await runWithRequestCache(async () => {
      expect(await cache.getAll()).toEqual([1]);
      cache.invalidate();
      expect(await cache.getAll()).toEqual([2]);
    });
  });

  test("fetches directly without request context", async () => {
    const { fetcher, getCalls } = trackedFetcher(() => [1, 2, 3]);
    const cache = requestCache(fetcher);

    await cache.getAll();
    await cache.getAll();
    expect(getCalls()).toBe(2); // no caching
  });

  test("concurrent reads within request share one fetch", async () => {
    const { fetcher, getCalls } = trackedFetcher(() => [1, 2, 3]);
    const cache = requestCache(fetcher);

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
