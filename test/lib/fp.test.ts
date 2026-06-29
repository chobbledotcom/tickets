import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  asString,
  bracket,
  collectionCache,
  filter,
  firstMatch,
  flatMap,
  lazyRef,
  map,
  once,
  pipe,
  ttlCache,
} from "#fp";

// --- test helpers ---

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
      return undefined;
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
      // null = "claimed but invalid"; a later defined value must not win.
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

  describe("pipe", () => {
    type Item = { id: number; active: boolean };

    test("threads intermediate callback types across 2-4 stages", () => {
      const items: Item[] = [
        { active: true, id: 1 },
        { active: false, id: 2 },
        { active: true, id: 3 },
      ];

      // 2-stage: map's callback infers Item from filter's output.
      const ids = pipe(
        filter((x: Item) => x.active),
        map((x) => x.id),
      )(items);
      const idsTypeCheck: number[] = ids;

      // 3-stage: second filter infers number from map's output.
      const bigIds = pipe(
        filter((x: Item) => x.active),
        map((x) => x.id),
        filter((x) => x > 0),
      )(items);
      const bigIdsTypeCheck: number[] = bigIds;

      // 4-stage: final map infers number -> string.
      const labels = pipe(
        filter((x: Item) => x.active),
        map((x) => x.id),
        filter((x) => x > 0),
        map((x) => `id-${x}`),
      )(items);
      const labelsTypeCheck: string[] = labels;

      expect(ids).toEqual([1, 3]);
      expect(bigIds).toEqual([1, 3]);
      expect(labels).toEqual(["id-1", "id-3"]);
      void idsTypeCheck;
      void bigIdsTypeCheck;
      void labelsTypeCheck;
    });

    test("flatMap callback infers its parameter mid-pipe", () => {
      const items: Item[] = [{ active: true, id: 1 }];
      const expanded = pipe(
        filter((x: Item) => x.active),
        flatMap((x) => [x.id, x.id + 1]),
      )(items);
      const typeCheck: number[] = expanded;
      expect(expanded).toEqual([1, 2]);
      void typeCheck;
    });

    test("identity overload returns input unchanged", () => {
      const id = pipe<number>();
      const out: number = id(42);
      expect(out).toBe(42);
    });

    test("rejects a mismatched chain at compile time", () => {
      // Produces number[] then feeds a stage expecting string -> no overload
      // matches, so the whole call fails to compile.
      const make = () =>
        pipe(
          // @ts-expect-error number[] (from x.length) is not assignable to string[]
          map((x: string) => x.length),
          map((x: string) => x.toUpperCase()),
        );
      void make;
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

      // Start a fetch (simulates a concurrent request loading listings)
      const fetchPromise = cache.getAll();

      // While fetch is in-flight, invalidate (simulates listing creation)
      cache.invalidate();

      // Resolve the in-flight fetch with stale data (missing the new listing)
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
