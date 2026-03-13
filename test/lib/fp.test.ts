import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  boundedLru,
  bracket,
  collectionCache,
  compact,
  err,
  filter,
  flatMap,
  groupBy,
  identity,
  isDefined,
  lazyRef,
  map,
  mapParallel,
  mapSequential,
  ok,
  once,
  pick,
  pipe,
  pipeAsync,
  reduce,
  sort,
  sortBy,
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

/** Create a boundedLru seeded with {a:1, b:2} */
const seededLru = (capacity: number) => {
  const cache = boundedLru<string, number>(capacity);
  cache.set("a", 1);
  cache.set("b", 2);
  return cache;
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

  describe("sortBy", () => {
    test("sorts by property key", () => {
      const items = [{ name: "c" }, { name: "a" }, { name: "b" }];
      const result = sortBy<{ name: string }>("name")(items);
      expect(result).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
    });

    test("sorts by getter function", () => {
      const items = [{ value: 3 }, { value: 1 }, { value: 2 }];
      const result = sortBy((x: { value: number }) => x.value)(items);
      expect(result).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    });

    test("does not mutate original", () => {
      const original = [{ n: 2 }, { n: 1 }];
      sortBy<{ n: number }>("n")(original);
      expect(original).toEqual([{ n: 2 }, { n: 1 }]);
    });

    test("preserves order of equal items", () => {
      const items = [
        { name: "b", id: 1 },
        { name: "a", id: 2 },
        { name: "a", id: 3 },
      ];
      const result = sortBy<{ name: string; id: number }>("name")(items);
      // Items with same name should maintain relative order (stable sort)
      expect(result[0]).toEqual({ name: "a", id: 2 });
      expect(result[1]).toEqual({ name: "a", id: 3 });
      expect(result[2]).toEqual({ name: "b", id: 1 });
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

  describe("groupBy", () => {
    test("groups items by key function", () => {
      const items = [
        { type: "a", value: 1 },
        { type: "b", value: 2 },
        { type: "a", value: 3 },
      ];
      const result = groupBy((x: { type: string; value: number }) => x.type)(
        items,
      );
      expect(result).toEqual({
        a: [
          { type: "a", value: 1 },
          { type: "a", value: 3 },
        ],
        b: [{ type: "b", value: 2 }],
      });
    });

    test("handles empty array", () => {
      const result = groupBy((x: { type: string }) => x.type)([]);
      expect(result).toEqual({});
    });
  });

  describe("pick", () => {
    test("picks specified keys from object", () => {
      const obj = { a: 1, b: 2, c: 3 };
      const result = pick<typeof obj, "a" | "c">(["a", "c"])(obj);
      expect(result).toEqual({ a: 1, c: 3 });
    });

    test("ignores missing keys", () => {
      const obj = { a: 1, b: 2 };
      const result = pick<typeof obj, "a">(["a"])(obj);
      expect(result).toEqual({ a: 1 });
    });
  });

  describe("isDefined", () => {
    test("returns true for defined values", () => {
      expect(isDefined(0)).toBe(true);
      expect(isDefined("")).toBe(true);
      expect(isDefined(false)).toBe(true);
      expect(isDefined([])).toBe(true);
    });

    test("returns false for null and undefined", () => {
      expect(isDefined(null)).toBe(false);
      expect(isDefined(undefined)).toBe(false);
    });
  });

  describe("identity", () => {
    test("returns the same value", () => {
      expect(identity(5)).toBe(5);
      expect(identity("hello")).toBe("hello");
      const obj = { a: 1 };
      expect(identity(obj)).toBe(obj);
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

  describe("ok and err", () => {
    test("ok creates successful result", () => {
      const result = ok(42);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    test("err creates failed result", () => {
      const response = new Response("error", { status: 400 });
      const result = err(response);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response).toBe(response);
      }
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

  describe("pipeAsync", () => {
    const asyncAddOne = (x: number) => Promise.resolve(x + 1);
    const asyncDouble = (x: number) => Promise.resolve(x * 2);

    test("composes async functions left-to-right", async () => {
      expect(await pipeAsync(asyncAddOne, asyncDouble)(5)).toBe(12);
    });

    test("works with single async function", async () => {
      expect(await pipeAsync(asyncAddOne)(5)).toBe(6);
    });
  });

  describe("mapSequential", () => {
    const asyncDouble = (x: number) => Promise.resolve(x * 2);

    test("maps array with async function", async () => {
      expect(await mapSequential(asyncDouble)([2, 3, 4])).toEqual([4, 6, 8]);
    });

    test("preserves order with async operations", async () => {
      const wait = (ms: number) => Promise.resolve(ms);
      expect(await mapSequential(wait)([30, 10, 20])).toEqual([30, 10, 20]);
    });

    test("handles empty array", async () => {
      expect(await mapSequential(asyncDouble)([])).toEqual([]);
    });
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

  describe("boundedLru", () => {
    test("stores and retrieves values", () => {
      const cache = seededLru(3);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
    });

    test("returns undefined for missing keys", () => {
      expect(boundedLru<string, number>(3).get("missing")).toBe(undefined);
    });

    test("evicts oldest entry when at capacity", () => {
      const cache = seededLru(2);
      cache.set("c", 3); // evicts "a"
      expect(cache.get("a")).toBe(undefined);
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
    });

    test("get promotes entry to most recent", () => {
      const cache = seededLru(2);
      cache.get("a"); // promotes "a" to most recent
      cache.set("c", 3); // evicts "b" (now oldest)
      expect(cache.get("b")).toBe(undefined); // evicted
      expect(cache.get("c")).toBe(3);
      expect(cache.get("a")).toBe(1); // still present
    });

    test("set updates existing entry without eviction", () => {
      const cache = seededLru(2);
      cache.set("a", 10); // update, not insert
      expect(cache.size()).toBe(2);
      expect(cache.get("a")).toBe(10);
    });

    test("size tracks entries and clear resets", () => {
      const cache = boundedLru<string, number>(5);
      expect(cache.size()).toBe(0);
      cache.set("a", 1);
      expect(cache.size()).toBe(1);
      cache.set("b", 2);
      expect(cache.size()).toBe(2);
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get("a")).toBe(undefined);
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
  });
});
