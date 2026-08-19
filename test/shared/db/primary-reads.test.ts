import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createPrimaryCacheRefill,
  mustReadFromPrimary,
  runWithPrimaryReads,
} from "#db/primary-reads.ts";

describe("db > primary reads", () => {
  test("uses the primary only inside its async scope", async () => {
    expect(mustReadFromPrimary()).toBe(false);

    await runWithPrimaryReads(async () => {
      await Promise.resolve();
      expect(mustReadFromPrimary()).toBe(true);
    });

    expect(mustReadFromPrimary()).toBe(false);
  });

  test("cache refills use the primary only during the catch-up window", async () => {
    let clock = 1000;
    const reads: boolean[] = [];
    const refill = createPrimaryCacheRefill(() => clock, 10);
    const fetch = (): Promise<void> => {
      reads.push(mustReadFromPrimary());
      return Promise.resolve();
    };

    await refill.fetch(fetch);
    refill.afterInvalidation(true);
    await refill.fetch(fetch);
    refill.afterInvalidation(false);
    await refill.fetch(fetch);
    clock += 11;
    await refill.fetch(fetch);

    expect(reads).toEqual([false, true, true, false]);
  });
});
