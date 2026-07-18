/**
 * address_cache table: HMAC blind index, encrypted-at-rest results, expiry
 * filtering on reads, upsert-on-conflict, and the prune task.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  computeAddressSearchIndex,
  getCachedAddresses,
  storeCachedAddresses,
} from "#shared/db/address-cache.ts";
import { queryOne } from "#shared/db/client.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { ADDRESS_CACHE_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const ADDRESSES = [
  {
    lat: "51.503396",
    line: "10 Downing Street, LONDON, SW1A 2AA",
    lng: "-0.127640",
  },
  { lat: "", line: "11 Downing Street", lng: "" },
];

/** Backdate a cached row's created stamp by `ageMs`. */
const backdateRow = async (searchIndex: string, ageMs: number) => {
  const { execute } = await import("#shared/db/client.ts");
  await execute("UPDATE address_cache SET created = ? WHERE search_index = ?", [
    new Date(nowMs() - ageMs).toISOString(),
    searchIndex,
  ]);
};

describeWithEnv("address cache", { db: true }, () => {
  test("stores and returns a result list by search index", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(index, ADDRESSES);
    expect(await getCachedAddresses(index)).toEqual(ADDRESSES);
  });

  test("caches an empty result list distinctly from a miss", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "ZZ99 9ZZ");
    await storeCachedAddresses(index, []);
    expect(await getCachedAddresses(index)).toEqual([]);
  });

  test("misses for a search that was never cached", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "M1 1AE");
    expect(await getCachedAddresses(index)).toBeNull();
  });

  test("the search index is an HMAC, not the search text", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    expect(index).not.toContain("SW1A");
    expect(index).not.toContain("easypostcodes");
  });

  test("two providers' caches for the same search never collide", async () => {
    const a = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    const b = await computeAddressSearchIndex("other-provider", "SW1A 2AA");
    expect(a).not.toBe(b);
  });

  test("results are encrypted at rest", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(index, ADDRESSES);
    const row = await queryOne<{ results: string }>(
      "SELECT results FROM address_cache WHERE search_index = ?",
      [index],
    );
    expect(row!.results.startsWith("enc:1:")).toBe(true);
    expect(row!.results).not.toContain("Downing");
  });

  test("a row cached before coordinates existed reads as a miss", async () => {
    // Old rows hold a JSON array of bare line strings; serving them would pin
    // nothing for up to the whole cache window, so the next lookup re-fetches
    // the postcode with coordinates and overwrites the row instead.
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(index, [
      "Legacy Address Line",
    ] as unknown as Parameters<typeof storeCachedAddresses>[1]);
    expect(await getCachedAddresses(index)).toBeNull();
  });

  test("re-storing a search replaces the previous row", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(index, [{ lat: "", line: "old line", lng: "" }]);
    await storeCachedAddresses(index, ADDRESSES);
    expect(await getCachedAddresses(index)).toEqual(ADDRESSES);
    const count = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM address_cache",
    );
    expect(count!.n).toBe(1);
  });

  test("an expired row is never served, even before pruning", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(index, ADDRESSES);
    await backdateRow(index, ADDRESS_CACHE_MS + 1000);
    expect(await getCachedAddresses(index)).toBeNull();
  });

  test("a row just inside the window is still served", async () => {
    const index = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(index, ADDRESSES);
    await backdateRow(index, ADDRESS_CACHE_MS - 60_000);
    expect(await getCachedAddresses(index)).toEqual(ADDRESSES);
  });

  test("pruneAddressCache deletes only expired rows", async () => {
    const stale = await computeAddressSearchIndex("easypostcodes", "M1 1AE");
    const fresh = await computeAddressSearchIndex("easypostcodes", "SW1A 2AA");
    await storeCachedAddresses(stale, [{ lat: "", line: "old", lng: "" }]);
    await storeCachedAddresses(fresh, ADDRESSES);
    await backdateRow(stale, ADDRESS_CACHE_MS + 1000);

    await runDatabasePruning();

    const count = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM address_cache",
    );
    expect(count!.n).toBe(1);
    expect(await getCachedAddresses(fresh)).toEqual(ADDRESSES);
  });
});
