import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createPrimaryCacheRefill,
  mustReadFromPrimary,
  runWithPrimaryReads,
} from "#db/primary-reads.ts";

/** A mutable clock, a refill reading it, and a fetch recording which
 * database every read took. */
const refillHarness = (catchUpMs?: number) => {
  const clock = { value: 0 };
  const reads: boolean[] = [];
  const refill =
    catchUpMs === undefined
      ? createPrimaryCacheRefill(() => clock.value)
      : createPrimaryCacheRefill(() => clock.value, catchUpMs);
  return {
    clock,
    fetch: (): Promise<void> => {
      reads.push(mustReadFromPrimary());
      return Promise.resolve();
    },
    reads,
    refill,
  };
};

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
    const { clock, fetch, reads, refill } = refillHarness(10);

    await refill.fetch(fetch);
    refill.afterInvalidation(true);
    await refill.fetch(fetch);
    refill.afterInvalidation(false);
    await refill.fetch(fetch);
    clock.value += 11;
    await refill.fetch(fetch);

    expect(reads).toEqual([false, true, true, false]);
  });

  test("the default catch-up window is the module's 30 seconds", async () => {
    const { clock, fetch, reads, refill } = refillHarness();
    // No catchUpMs argument: the module default (30_000ms) must hold the
    // primary reads for a fresh replica's real catch-up time.
    refill.afterInvalidation(true);
    clock.value = 29_999;
    await refill.fetch(fetch);
    clock.value = 30_001;
    await refill.fetch(fetch);

    expect(reads).toEqual([true, false]);
  });

  test("reads the replica before any invalidation", async () => {
    const { fetch, reads, refill } = refillHarness(10);

    await refill.fetch(fetch);

    expect(reads).toEqual([false]);
  });

  test("each invalidation sets its window from its own moment", async () => {
    const { clock, fetch, reads, refill } = refillHarness(10);

    refill.afterInvalidation(true);
    clock.value = 1005;
    refill.afterInvalidation(true);
    clock.value = 1008;
    await refill.fetch(fetch);
    clock.value = 1020;
    await refill.fetch(fetch);

    // The second invalidation's window runs 1005..1015: a later read is off
    // the primary again. Adding onto the old deadline instead would still
    // read the primary at 1020.
    expect(reads).toEqual([true, false]);
  });
});
