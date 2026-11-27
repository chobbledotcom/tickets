import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { asString, bracket, firstMatch, lazyRef, once, ttlCache } from "#fp";

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

const bracketUse = async (asPromise = false) => {
  const { log, withResource } = logBracket(asPromise);
  const result = await withResource((resource) => {
    log.push(`use: ${resource}`);
    return asPromise ? Promise.resolve("done") : "done";
  });
  return { log, result };
};

const BRACKET_USE = {
  log: ["acquire", "use: resource", "release"],
  result: "done",
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
    test("acquires and releases resource", async () => {
      expect(await bracketUse()).toEqual(BRACKET_USE);
    });

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

    test("works with async acquire and release", async () => {
      expect(await bracketUse(true)).toEqual(BRACKET_USE);
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

    test("a refreshed entry is not the one evicted at the cap", () => {
      const cache = ttlCache<string, number>(1000, () => 0, 2);
      cache.set("refreshed", 1);
      cache.set("stale", 2);
      // Storing an existing key again makes it the newest entry, so the next
      // eviction takes the other one.
      cache.set("refreshed", 10);
      cache.set("new", 3);
      expect(cache.get("stale")).toBe(undefined);
      expect(cache.get("refreshed")).toBe(10);
      expect(cache.get("new")).toBe(3);
    });

    test("grows without limit when no cap is given", () => {
      const cache = ttlCache<number, number>(1000, () => 0);
      for (let i = 0; i < 1010; i++) {
        cache.set(i, i);
      }
      expect(cache.size()).toBe(1010);
      expect(cache.get(0)).toBe(0);
    });
  });
});
