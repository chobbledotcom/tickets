import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  asString,
  bracket,
  collectionCache,
  firstMatch,
  lazyRef,
  once,
  TTL_CACHE_MAX_ENTRIES,
  ttlCache,
} from "#fp";

const logBracket = (asPromise = false) => {
  const log: string[] = [];
  const withResource = bracket(
    () => {
      log.push("acquire");
      return asPromise ? Promise.resolve("resource") : "resource";
    },
    () => {
      log.push("release");
      if (asPromise) return Promise.resolve();
      return;
    },
  );
  return { log, withResource };
};

const testBracketUse = async (asPromise = false) => {
  const { log, withResource } = logBracket(asPromise);
  const result = await withResource((resource) => {
    log.push(`use: ${resource}`);
    return asPromise ? Promise.resolve("done") : "done";
  });
  expect(result).toBe("done");
  expect(log).toEqual(["acquire", "use: resource", "release"]);
};

const timedTtl = (ttl: number) => {
  let time = 0;
  const cache = ttlCache<string, number>(ttl, () => time);
  return {
    cache,
    setTime: (next: number) => {
      time = next;
    },
  };
};

const trackedCollection = (fetchFn?: (count: number) => unknown[]) => {
  let time = 0;
  const calls: number[] = [];
  const fetcher = () => {
    calls.push(1);
    const items = fetchFn ? fetchFn(calls.length) : [1, 2, 3];
    return Promise.resolve(items);
  };
  const cache = collectionCache(fetcher, 100, () => time);
  return {
    cache,
    calls,
    setTime: (next: number) => {
      time = next;
    },
  };
};

const fetchedDynCollection = async () => {
  const tracked = trackedCollection((count) => [count]);
  await tracked.cache.getAll();
  expect(tracked.calls.length).toBe(1);
  return tracked;
};

const expectRefetched = async (
  tracked: ReturnType<typeof trackedCollection>,
) => {
  expect(await tracked.cache.getAll()).toEqual([2]);
  expect(tracked.calls.length).toBe(2);
};

describe("fp caches and resources", () => {
  describe("asString", () => {
    test("returns string values unchanged", () => {
      expect(asString("hello")).toBe("hello");
      expect(asString("")).toBe("");
    });

    test("returns empty string for non-string values", () => {
      expect(asString(42)).toBe("");
      expect(asString(null)).toBe("");
      expect(asString(undefined)).toBe("");
      expect(asString(true)).toBe("");
      expect(asString({ id: 1 })).toBe("");
    });
  });

  describe("firstMatch", () => {
    test("returns the first defined result", async () => {
      expect(await firstMatch([() => undefined, () => "b", () => "c"])).toBe(
        "b",
      );
    });

    test("treats null as a match and stops there", async () => {
      expect(await firstMatch([() => null, () => "late"])).toBe(null);
    });

    test("returns undefined when every producer declines", async () => {
      expect(await firstMatch([() => undefined, () => undefined])).toBe(
        undefined,
      );
    });

    test("returns undefined for no producers", async () => {
      expect(await firstMatch<string>([])).toBe(undefined);
    });

    test("awaits async producers in order", async () => {
      expect(
        await firstMatch([
          () => Promise.resolve(undefined),
          () => Promise.resolve("async"),
        ]),
      ).toBe("async");
    });

    test("does not call producers after the first match", async () => {
      let laterCalled = false;
      const result = await firstMatch([
        () => "first",
        () => {
          laterCalled = true;
          return "second";
        },
      ]);
      expect(result).toBe("first");
      expect(laterCalled).toBe(false);
    });
  });

  describe("once", () => {
    test("computes value once and caches", () => {
      let callCount = 0;
      const getValue = once(() => {
        callCount++;
        return "computed";
      });
      const first = getValue();
      const second = getValue();
      expect(first).toBe("computed");
      expect(second).toBe(first);
      expect(callCount).toBe(1);
    });
  });

  describe("lazyRef", () => {
    test("computes value lazily", () => {
      let callCount = 0;
      const [get] = lazyRef(() => {
        callCount++;
        return "computed";
      });

      expect(callCount).toBe(0);
      expect(get()).toBe("computed");
      expect(callCount).toBe(1);
      expect(get()).toBe("computed");
      expect(callCount).toBe(1);
    });

    test("can be reset with set(null)", () => {
      let callCount = 0;
      const [get, set] = lazyRef(() => {
        callCount++;
        return `computed-${callCount}`;
      });

      expect(get()).toBe("computed-1");
      set(null);
      expect(get()).toBe("computed-2");
    });

    test("can be set to a specific value", () => {
      const [get, set] = lazyRef(() => "default");
      set("overridden");
      expect(get()).toBe("overridden");
    });
  });

  describe("bracket", () => {
    test("acquires and releases resource", () => testBracketUse());

    test("releases resource even on error", async () => {
      const { log, withResource } = logBracket();
      await expect(
        withResource(() => {
          log.push("use");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(log).toEqual(["acquire", "use", "release"]);
    });

    test("works with async acquire and release", () => testBracketUse(true));
  });

  describe("ttlCache", () => {
    test("stores and retrieves values within TTL", () => {
      const { cache } = timedTtl(1000);
      cache.set("a", 1);
      expect(cache.get("a")).toBe(1);
    });

    test("returns undefined for missing keys", () => {
      expect(timedTtl(1000).cache.get("missing")).toBe(undefined);
    });

    test("expires entries after TTL", () => {
      const { cache, setTime } = timedTtl(100);
      cache.set("a", 1);
      setTime(50);
      expect(cache.get("a")).toBe(1);
      setTime(100);
      expect(cache.get("a")).toBe(1);
      setTime(101);
      expect(cache.get("a")).toBe(undefined);
      expect(cache.size()).toBe(0);
    });

    test("clear empties the cache", () => {
      const { cache } = timedTtl(1000);
      cache.set("x", 10);
      cache.set("y", 20);
      cache.clear();
      expect(cache.get("x")).toBe(undefined);
      expect(cache.get("y")).toBe(undefined);
    });

    test("each entry has independent TTL", () => {
      const { cache, setTime } = timedTtl(100);
      cache.set("early", 1);
      setTime(60);
      cache.set("late", 2);
      setTime(101);
      expect(cache.get("early")).toBe(undefined);
      expect(cache.get("late")).toBe(2);
    });

    test("size tracks entries and clear", () => {
      const { cache } = timedTtl(1000);
      expect(cache.size()).toBe(0);
      cache.set("p", 1);
      expect(cache.size()).toBe(1);
      cache.set("q", 2);
      expect(cache.size()).toBe(2);
      expect(cache.get("q")).toBe(2);
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    test("drops the oldest entry when a new key arrives at the cap", () => {
      const cache = ttlCache<string, number>(1000, () => 0, 2);
      cache.set("first", 1);
      cache.set("second", 2);
      cache.set("third", 3);
      expect(cache.size()).toBe(2);
      expect(cache.get("first")).toBe(undefined);
      expect(cache.get("second")).toBe(2);
      expect(cache.get("third")).toBe(3);
    });

    test("re-storing a known key at the cap evicts nothing", () => {
      const cache = ttlCache<string, number>(1000, () => 0, 2);
      cache.set("keep", 1);
      cache.set("update", 2);
      cache.set("update", 20);
      expect(cache.size()).toBe(2);
      expect(cache.get("keep")).toBe(1);
      expect(cache.get("update")).toBe(20);
    });

    test("holds no more than the default cap of entries", () => {
      const cache = ttlCache<number, number>(1000, () => 0);
      for (let i = 0; i < TTL_CACHE_MAX_ENTRIES + 10; i++) {
        cache.set(i, i);
      }
      expect(cache.size()).toBe(TTL_CACHE_MAX_ENTRIES);
      // The newest entries survive; the earliest were dropped to make room.
      expect(cache.get(0)).toBe(undefined);
      expect(cache.get(TTL_CACHE_MAX_ENTRIES + 9)).toBe(
        TTL_CACHE_MAX_ENTRIES + 9,
      );
    });
  });

  describe("collectionCache", () => {
    test("fetches on first call and caches within TTL", async () => {
      const { cache, calls, setTime } = trackedCollection();
      const initial = await cache.getAll();
      expect(initial).toEqual([1, 2, 3]);
      expect(calls.length).toBe(1);
      setTime(50);
      expect(await cache.getAll()).toBe(initial);
    });

    test("refetches after TTL expires", async () => {
      const tracked = await fetchedDynCollection();
      tracked.setTime(101);
      await expectRefetched(tracked);
    });

    test("keeps the collection exactly until the TTL is passed", async () => {
      const tracked = await fetchedDynCollection();
      tracked.setTime(100);
      expect(await tracked.cache.getAll()).toEqual([1]);
      expect(tracked.calls.length).toBe(1);
    });

    test("refetches after invalidate", async () => {
      const tracked = await fetchedDynCollection();
      tracked.cache.invalidate();
      await expectRefetched(tracked);
    });

    test("invalidate resets TTL timer", async () => {
      const tracked = await fetchedDynCollection();
      tracked.setTime(80);
      tracked.cache.invalidate();
      await tracked.cache.getAll();
      tracked.setTime(150);
      await expectRefetched(tracked);
    });

    test("size reflects load and invalidate lifecycle", async () => {
      const { cache } = trackedCollection();
      expect(cache.size()).toBe(0);
      await cache.getAll();
      expect(cache.size()).toBe(3);
      cache.invalidate();
      expect(cache.size()).toBe(0);
    });

    test("invalidation during in-flight fetch prevents stale cache", async () => {
      let resolveFetch!: (items: number[]) => void;
      const cache = collectionCache(
        () =>
          new Promise<number[]>((resolve) => {
            resolveFetch = resolve;
          }),
        100,
      );
      const fetchPromise = cache.getAll();
      cache.invalidate();
      resolveFetch([1, 2]);
      expect(await fetchPromise).toEqual([1, 2]);
      expect(cache.size()).toBe(0);

      const freshPromise = cache.getAll();
      resolveFetch([1, 2, 3]);
      expect(await freshPromise).toEqual([1, 2, 3]);
      expect(cache.size()).toBe(3);
    });
  });
});
