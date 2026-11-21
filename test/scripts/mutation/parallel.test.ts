import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { inParallel } from "#scripts/mutation/parallel.ts";

describe("the worker pool", () => {
  test("gives every item's result in order, and each worker one item at a time", async () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    for (const count of [1, 3, 20]) {
      const workers = Array.from({ length: count }, (_, worker) => worker);
      const busy = new Set<number>();
      const releases = items.map(() => Promise.withResolvers<void>());
      let most = 0;
      const results = inParallel(items, workers, async (item, _, worker) => {
        expect(busy.has(worker)).toBe(false);
        busy.add(worker);
        most = Math.max(most, busy.size);
        await releases[item]!.promise;
        busy.delete(worker);
        return item * 10;
      });
      // Every worker has taken its first item and is waiting there.
      expect(most).toBe(Math.min(count, items.length));
      for (const release of releases) release.resolve();
      expect(await results).toEqual(items.map((item) => item * 10));
    }
  });

  test("returns no results when there is nothing to do", async () => {
    let calls = 0;
    const results = await inParallel([], [1, 2], () => {
      calls += 1;
      return Promise.resolve("never");
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});
