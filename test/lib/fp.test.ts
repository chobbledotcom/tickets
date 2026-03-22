import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bracket,
  chunk,
  collectionCache,
  compact,
  filter,
  flatMap,
  lazyRef,
  map,
  mapParallel,
  once,
  pipe,
  reduce,
  sort,
  ttlCache,
  unique,
  uniqueBy,
} from "#fp";

// --- test helpers ---

const double = (x: number) => x * 2;

/** Curried fn returns [] for empty input */
const expectEmptyPassthrough = (curriedFn: (arr: number[]) => unknown) => {
  expect(curriedFn([])).toEqual([]);
};

/** Create a bracket that logs acquire/use/release to an array */
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
    },
  );
  return { log, withResource };
};

/** Run standard bracket use+assert cycle */
const testBracketUse = async (asPromise = false) => {
  const { log, withResource } = logBracket(asPromise);
  const result = await withResource((r) => {
    log.push(`use: ${r}`);
    return asPromise ? Promise.resolve("done") : "done";
  });
  expect(result).toBe("done");
  expect(log).toEqual(["acquire", "use: resource", "release"]);
};

/** Create a ttlCache with controllable clock */
const timedTtl = (ttl: number) => {
  let time = 0;
  const cache = ttlCache<string, number>(ttl, () => time);
  return {
    cache,
    setTime: (t: number) => {
      time = t;
    },
  };
};

/** Create a collectionCache with call tracking and controllable clock */
const trackedCollection = (fetchFn?: (n: number) => unknown[]) => {
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
    setTime: (t: number) => {
      time = t;
    },
  };
};

/** Create a dynamic tracked collection and do the initial fetch */
const fetchedDynCollection = async () => {
  const tc = trackedCollection((n) => [n]);
  await tc.cache.getAll();
  expect(tc.calls.length).toBe(1);
  return tc;
};

/** Assert a refetch occurred producing the expected second-call result */
const expectRefetched = async (tc: ReturnType<typeof trackedCollection>) => {
  expect(await tc.cache.getAll()).toEqual([2]);
  expect(tc.calls.length).toBe(2);
};

describe("fp", () => {
  describe("pipe", () => {
    test("composes functions left-to-right", () => {
      const addOne = (x: number) => x + 1;
      expect(pipe(addOne, double)(5)).toBe(12); // (5 + 1) * 2
    });

    test("works with single function", () => {
      expect(pipe(double)(5)).toBe(10);
    });

    test("works with no functions", () => {
      expect(pipe<number>()(5)).toBe(5);
    });

    test("works with 6+ functions (recursive type catch-all)", () => {
      const addOne = (x: number) => x + 1;
      const result = pipe(addOne, double, addOne, double, addOne, double)(0); // (((((0+1)*2)+1)*2)+1)*2 = ((((1*2)+1)*2)+1)*2 = (((2+1)*2)+1)*2 = ((3*2)+1)*2 = (6+1)*2 = 14
      expect(result).toBe(14);
    });
  });

  describe("filter", () => {
    test("filters array based on predicate", () => {
      const isEven = (x: number) => x % 2 === 0;
      expect(filter(isEven)([1, 2, 3, 4, 5, 6])).toEqual([2, 4, 6]);
    });

    test("returns empty array when no matches", () => {
      const isNegative = (x: number) => x < 0;
      expect(filter(isNegative)([1, 2, 3])).toEqual([]);
    });
  });

  describe("map", () => {
    test("transforms array elements", () => {
      expect(map(double)([1, 2, 3])).toEqual([2, 4, 6]);
    });

    test("works with empty array", () => {
      expectEmptyPassthrough(map(double));
    });
  });

  describe("flatMap", () => {
    test("maps and flattens results", () => {
      const duplicate = (x: number) => [x, x];
      expect(flatMap(duplicate)([1, 2, 3])).toEqual([1, 1, 2, 2, 3, 3]);
    });

    test("works with empty array", () => {
      expectEmptyPassthrough(flatMap((x: number) => [x, x]));
    });
  });

  describe("reduce", () => {
    test("reduces array to single value", () => {
      const sum = (acc: number, x: number) => acc + x;
      expect(reduce(sum, 0)([1, 2, 3, 4])).toBe(10);
    });

    test("works with mutation pattern", () => {
      const collect = (acc: number[], x: number) => {
        acc.push(x * 3);
        return acc;
      };
      expect(reduce(collect, [] as number[])([1, 2, 3])).toEqual([3, 6, 9]);
    });
  });

  describe("sort", () => {
    test("sorts array non-mutating", () => {
      const original = [3, 1, 2];
      const result = sort((a: number, b: number) => a - b)(original);
      expect(result).toEqual([1, 2, 3]);
      expect(original).toEqual([3, 1, 2]); // Original unchanged
    });

    test("sorts descending", () => {
      const result = sort((a: number, b: number) => b - a)([1, 3, 2]);
      expect(result).toEqual([3, 2, 1]);
    });
  });

  describe("unique", () => {
    test("removes duplicate primitives", () => {
      const result = unique([1, 2, 2, 3, 3, 3]);
      expect(result).toEqual([1, 2, 3]);
    });

    test("works with strings", () => {
      const result = unique(["a", "b", "a", "c"]);
      expect(result).toEqual(["a", "b", "c"]);
    });

    test("handles empty array", () => {
      expectEmptyPassthrough(unique);
    });
  });

  describe("uniqueBy", () => {
    test("removes duplicates by key function", () => {
      const items = [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
        { id: 1, name: "c" },
      ];
      expect(
        uniqueBy((x: { id: number; name: string }) => x.id)(items),
      ).toEqual([
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ]);
    });

    test("handles empty array", () => {
      expectEmptyPassthrough(uniqueBy((x: number) => x));
    });
  });

  describe("compact", () => {
    test("removes null and undefined", () => {
      expect(compact([1, null, 2, undefined, 3, 4])).toEqual([1, 2, 3, 4]);
    });

    test("preserves 0, empty string, and false", () => {
      expect(compact([0, "", false, null, undefined])).toEqual([0, "", false]);
    });

    test("handles empty array", () => {
      expectEmptyPassthrough(compact);
    });

    test("removes only null and undefined from mixed array", () => {
      const result = compact([null, undefined]);
      expect(result).toEqual([]);
    });
  });

  describe("chunk", () => {
    test("splits array into chunks of given size", () => {
      expect(chunk(2)([1, 2, 3, 4, 5])).toEqual([[1, 2], [3, 4], [5]]);
    });

    test("returns single chunk when array fits", () => {
      expect(chunk(5)([1, 2, 3])).toEqual([[1, 2, 3]]);
    });

    test("returns empty array for empty input", () => {
      expect(chunk(3)([])).toEqual([]);
    });

    test("handles exact multiples", () => {
      expect(chunk(2)([1, 2, 3, 4])).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    test("handles chunk size of 1", () => {
      expect(chunk(1)([1, 2, 3])).toEqual([[1], [2], [3]]);
    });
  });

  describe("composition", () => {
    test("works with pipe and curried functions", () => {
      const numbers = [1, 2, 3, 4, 5, 6];
      const result = pipe(
        filter((x: number) => x % 2 === 0),
        map((x: number) => x * 2),
      )(numbers);
      expect(result).toEqual([4, 8, 12]);
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
      const [get, _set] = lazyRef(() => {
        callCount++;
        return "computed";
      });

      expect(callCount).toBe(0);
      const first = get();
      expect(callCount).toBe(1);
      const second = get();
      expect(callCount).toBe(1); // not recomputed
      expect(first).toBe("computed");
      expect(second).toBe("computed");
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

  describe("mapParallel", () => {
    const asyncDouble = (x: number) => Promise.resolve(x * 2);

    test("maps array with async function", async () => {
      expect(await mapParallel(asyncDouble)([2, 3, 4])).toEqual([4, 6, 8]);
    });

    test("preserves result order regardless of completion order", async () => {
      const delayed = (ms: number) =>
        new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms));
      expect(await mapParallel(delayed)([30, 10, 20])).toEqual([30, 10, 20]);
    });

    test("handles empty array", async () => {
      expect(await mapParallel(asyncDouble)([])).toEqual([]);
    });

    test("runs operations concurrently", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const track = async (x: number) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return x;
      };
      await mapParallel(track)([1, 2, 3]);
      expect(maxConcurrent).toBe(3);
    });
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
      expect(cache.get("a")).toBe(1); // within TTL
      setTime(101);
      expect(cache.get("a")).toBe(undefined); // expired
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
      expect(cache.get("early")).toBe(undefined); // expired (set at 0, now 101)
      expect(cache.get("late")).toBe(2); // still valid (set at 60, now 101)
    });

    test("size tracks entries and clear", () => {
      const { cache } = timedTtl(1000);
      expect(cache.size()).toBe(0);
      cache.set("p", 1);
      expect(cache.size()).toBe(1);
      cache.set("q", 2);
      expect(cache.size()).toBe(2);
      expect(cache.get("q")).toBe(2); // entries still accessible
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe("collectionCache", () => {
    test("fetches on first call and caches within TTL", async () => {
      const { cache, calls, setTime } = trackedCollection();
      const initial = await cache.getAll();
      expect(initial).toEqual([1, 2, 3]);
      expect(calls.length).toBe(1);
      setTime(50);
      expect(await cache.getAll()).toBe(initial); // same reference = served from cache
    });

    test("refetches after TTL expires", async () => {
      const tc = await fetchedDynCollection();
      tc.setTime(101);
      await expectRefetched(tc);
    });

    test("refetches after invalidate", async () => {
      const tc = await fetchedDynCollection();
      tc.cache.invalidate();
      await expectRefetched(tc);
    });

    test("invalidate resets TTL timer", async () => {
      const tc = await fetchedDynCollection();
      tc.setTime(80);
      tc.cache.invalidate();
      await tc.cache.getAll();
      tc.setTime(150); // 150 - 80 = 70, within TTL of the refetch
      await expectRefetched(tc);
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
          new Promise<number[]>((r) => {
            resolveFetch = r;
          }),
        100,
      );

      // Start a fetch (simulates a concurrent request loading events)
      const fetchPromise = cache.getAll();

      // While fetch is in-flight, invalidate (simulates event creation)
      cache.invalidate();

      // Resolve the in-flight fetch with stale data (missing the new event)
      resolveFetch([1, 2]);
      const staleResult = await fetchPromise;
      expect(staleResult).toEqual([1, 2]); // caller gets what was fetched

      // The stale data should NOT have been cached
      expect(cache.size()).toBe(0);

      // Next getAll should re-fetch fresh data
      const freshPromise = cache.getAll();
      resolveFetch([1, 2, 3]);
      const freshResult = await freshPromise;
      expect(freshResult).toEqual([1, 2, 3]);
      // Now the cache IS populated with fresh data
      expect(cache.size()).toBe(3);
    });
  });
});
