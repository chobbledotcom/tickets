import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createKeyedCache } from "#db/keyed-cache.ts";
import type { TableHandle } from "#db/select/tables.ts";
import { tableCache } from "#db/table-cache.ts";
import {
  getAllCacheStats,
  invalidateCachesForWrite,
} from "#shared/cache-registry.ts";

type CachedRow = { id: number; key: string };

const ROWS: CachedRow[] = [
  { id: 1, key: "one" },
  { id: 2, key: "two" },
];

/** A table that no other cache names, so the registry entry that a test
 *  leaves behind cannot match the entry of another test. */
const tableNamed = (name: string): TableHandle<string> => ({
  columns: [],
  name,
  singular: "row",
});

const cacheOver = (name: string, dependsOn: readonly string[] = []) =>
  tableCache(
    tableNamed(name),
    createKeyedCache<CachedRow>({
      fetchAll: () => Promise.resolve(ROWS),
      idOf: (row) => row.id,
      keyOf: (row) => row.key,
      ttlMs: 60_000,
    }),
    dependsOn.map((table) => ({ table })),
  );

const entriesNamed = (name: string): number | undefined =>
  getAllCacheStats().find((stat) => stat.name === name)?.entries;

describe("tableCache", () => {
  test("gives back the cache that it registers", async () => {
    const cache = cacheOver("table-cache-test-returned");
    expect(await cache.getAll()).toEqual(ROWS);
  });

  test("reports the live size of the cache under the table name", async () => {
    const cache = cacheOver("table-cache-test-stats");
    expect(entriesNamed("table-cache-test-stats")).toBe(0);
    await cache.getAll();
    expect(entriesNamed("table-cache-test-stats")).toBe(ROWS.length);
  });

  test("clears the cache when its own table is written", async () => {
    const cache = cacheOver("table-cache-test-own-table");
    await cache.getAll();
    expect(cache.size()).toBe(ROWS.length);
    invalidateCachesForWrite("table-cache-test-own-table", {
      updatedColumns: null,
    });
    expect(cache.size()).toBe(0);
  });

  test("clears the cache when a table that it depends on is written", async () => {
    const cache = cacheOver("table-cache-test-dependency", [
      "table-cache-test-source",
    ]);
    await cache.getAll();
    invalidateCachesForWrite("table-cache-test-source", {
      updatedColumns: null,
    });
    expect(cache.size()).toBe(0);
  });

  test("keeps the cache when an unrelated table is written", async () => {
    const cache = cacheOver("table-cache-test-unrelated");
    await cache.getAll();
    invalidateCachesForWrite("table-cache-test-elsewhere", {
      updatedColumns: null,
    });
    expect(cache.size()).toBe(ROWS.length);
  });
});
