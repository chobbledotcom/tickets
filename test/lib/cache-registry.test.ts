import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  getAllCacheStats,
  registerCache,
  resetCacheRegistry,
} from "#lib/cache-registry.ts";

describe("cache-registry", () => {
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
    expect(stats[0]!.name).toBe("test");
    expect(stats[0]!.entries).toBe(5);
  });

  test("supports capacity field", () => {
    registerCache(() => ({ name: "lru", entries: 100, capacity: 10000 }));
    const stats = getAllCacheStats();
    expect(stats[0]!.capacity).toBe(10000);
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
    expect(getAllCacheStats()[0]!.entries).toBe(1);
    expect(getAllCacheStats()[0]!.entries).toBe(2);
  });

  test("resetCacheRegistry clears all providers", () => {
    registerCache(() => ({ name: "test", entries: 1 }));
    expect(getAllCacheStats()).toHaveLength(1);
    resetCacheRegistry();
    expect(getAllCacheStats()).toHaveLength(0);
  });
});
