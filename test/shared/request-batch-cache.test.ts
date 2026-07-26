import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  requestBatchCache,
  runWithRequestCache,
} from "#shared/request-cache.ts";

/** A batch lookup that answers `id -> id * 10` and records what it was asked
 * for, so a test can prove which ids actually reached the database. */
const countingLookup = () => {
  const asked: number[][] = [];
  const cache = requestBatchCache<number>((ids) => {
    asked.push([...ids]);
    return Promise.resolve(new Map(ids.map((id) => [id, id * 10])));
  });
  return { asked, cache };
};

describe("requestBatchCache", () => {
  test("answers every id it is asked for", async () => {
    const { cache } = countingLookup();
    await runWithRequestCache(async () => {
      expect([...(await cache.getMany([2, 1]))]).toEqual([
        [2, 20],
        [1, 10],
      ]);
    });
  });

  test("looks up each id once per request", async () => {
    const { asked, cache } = countingLookup();
    await runWithRequestCache(async () => {
      await cache.getMany([1, 2]);
      await cache.getMany([1, 2]);
      expect(asked).toEqual([[1, 2]]);
    });
  });

  test("only looks up the ids it has not seen yet", async () => {
    const { asked, cache } = countingLookup();
    await runWithRequestCache(async () => {
      await cache.getMany([1, 2]);
      expect([...(await cache.getMany([1, 2, 3, 4]))]).toEqual([
        [1, 10],
        [2, 20],
        [3, 30],
        [4, 40],
      ]);
      expect(asked).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });
  });

  test("asks for a repeated id only once", async () => {
    const { asked, cache } = countingLookup();
    await runWithRequestCache(async () => {
      expect([...(await cache.getMany([5, 5]))]).toEqual([[5, 50]]);
      expect(asked).toEqual([[5]]);
    });
  });

  test("skips the lookup when asked for nothing", async () => {
    const { asked, cache } = countingLookup();
    await runWithRequestCache(async () => {
      expect([...(await cache.getMany([]))]).toEqual([]);
      expect(asked).toEqual([]);
    });
  });

  test("shares one lookup between overlapping concurrent callers", async () => {
    const { asked, cache } = countingLookup();
    await runWithRequestCache(async () => {
      const [first, second] = await Promise.all([
        cache.getMany([1, 2]),
        cache.getMany([2, 3]),
      ]);
      expect(first.get(2)).toBe(20);
      expect(second.get(2)).toBe(20);
      expect(asked).toEqual([[1, 2], [3]]);
    });
  });

  test("each request starts with nothing remembered", async () => {
    const { asked, cache } = countingLookup();
    await runWithRequestCache(() => cache.getMany([1]));
    await runWithRequestCache(() => cache.getMany([1]));
    expect(asked).toEqual([[1], [1]]);
  });

  test("invalidate drops what this request remembered", async () => {
    const { asked, cache } = countingLookup();
    await runWithRequestCache(async () => {
      await cache.getMany([1]);
      cache.invalidate("write");
      await cache.getMany([1]);
      expect(asked).toEqual([[1], [1]]);
    });
  });

  test("looks up every time outside a request", async () => {
    const { asked, cache } = countingLookup();
    expect([...(await cache.getMany([1]))]).toEqual([[1, 10]]);
    await cache.getMany([1]);
    expect(asked).toEqual([[1], [1]]);
  });

  test("a failed lookup is not remembered, so the next read retries", async () => {
    let attempts = 0;
    const cache = requestBatchCache<number>((ids) => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("lookup failed"))
        : Promise.resolve(new Map(ids.map((id) => [id, id])));
    });

    await runWithRequestCache(async () => {
      await expect(cache.getMany([1])).rejects.toThrow("lookup failed");
      expect([...(await cache.getMany([1]))]).toEqual([[1, 1]]);
      expect(attempts).toBe(2);
    });
  });

  test("throws when the lookup skips an id it was asked for", async () => {
    const cache = requestBatchCache<number>(() =>
      Promise.resolve(new Map([[1, 10]])),
    );
    await runWithRequestCache(async () => {
      await expect(cache.getMany([1, 2])).rejects.toThrow(
        "Missing batch result for id 2",
      );
    });
  });
});
