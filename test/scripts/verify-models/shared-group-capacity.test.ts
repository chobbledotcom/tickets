/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  dateLessSoldOutPairData,
  FACTS,
  overfillCapacityData,
  sharedGroupCapacityModelData,
} from "#scripts/verify-models/shared-group-capacity.ts";
import { PARENT_CHILD_GROUP_UNITS } from "#shared/group-capacity.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type Fact = Record<string, string | boolean | number>;

/** One expected fact, named by field: the allow gate, whether the pair reads
 *  no per-date remaining, the whole orders that fit, and the shared static
 *  cap and remaining spots. */
const fact = (
  allowed: boolean,
  dateLess: boolean,
  fits: number,
  hasStaticCap: boolean,
  remaining: number,
  staticCap: number,
): Fact => ({ allowed, dateLess, fits, hasStaticCap, remaining, staticCap });

/** The clean facts and the overfill facts, matched by position because the
 *  corruption keeps every fact and its order. */
const factLists = async (): Promise<[Fact[], Fact[]]> => {
  const honest = records(
    await sharedGroupCapacityModelData(),
    "GroupFacts",
  ) as Fact[];
  const corrupted = records(
    await overfillCapacityData(),
    "GroupFacts",
  ) as Fact[];
  return [honest, corrupted];
};

describe("shared group capacity checker data", () => {
  test("carries the production group units as the checker constant", async () => {
    const data = await sharedGroupCapacityModelData();
    expect(data).toContain(
      `PARENT_CHILD_GROUP_UNITS == ${PARENT_CHILD_GROUP_UNITS}`,
    );
  });

  test("records the production outputs for every scenario", async () => {
    const [facts] = await factLists();
    // Sixteen scenarios collapse to fourteen distinct facts: three produce
    // the plain capped pool.
    expect(facts).toHaveLength(14);
    // A pair that shares no capped group contends over nothing and is never
    // refused on either fact.
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: true,
      fits: 0,
      hasStaticCap: false,
      remaining: 0,
      staticCap: 0,
    });
    // The plain capped pool. A parent-only group with no spots and a tighter
    // child-only group do not drag this answer down.
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: false,
      fits: 2,
      hasStaticCap: true,
      remaining: 5,
      staticCap: 10,
    });
    // Several shared groups read their tightest cap and their tightest
    // remaining.
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: false,
      fits: 1,
      hasStaticCap: true,
      remaining: 2,
      staticCap: 4,
    });
    // The static cap and the remaining spots can come from different shared
    // groups.
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: false,
      fits: 2,
      hasStaticCap: true,
      remaining: 5,
      staticCap: 4,
    });
    // The date-less surface reads no per-date remaining, so only the static
    // cap below two spots can refuse the pair.
    expect(facts).toContainEqual({
      allowed: false,
      dateLess: true,
      fits: 0,
      hasStaticCap: true,
      remaining: 0,
      staticCap: 1,
    });
    // A date-less pair with a large static cap passes the gate.
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: true,
      fits: 0,
      hasStaticCap: true,
      remaining: 0,
      staticCap: 10,
    });
    // A pool of one spot fits no whole parent+child order.
    expect(facts).toContainEqual({
      allowed: false,
      dateLess: false,
      fits: 0,
      hasStaticCap: true,
      remaining: 1,
      staticCap: 10,
    });
    // The static cap below two refuses the pair even when spots remain.
    expect(facts).toContainEqual({
      allowed: false,
      dateLess: false,
      fits: 2,
      hasStaticCap: true,
      remaining: 5,
      staticCap: 1,
    });
    // With no static cap the remaining spots alone refuse a one-spot pool.
    expect(facts).toContainEqual({
      allowed: false,
      dateLess: false,
      fits: 0,
      hasStaticCap: false,
      remaining: 1,
      staticCap: 0,
    });
    // The one-spot static cap and the one-spot pool both refuse the pair.
    expect(facts).toContainEqual({
      allowed: false,
      dateLess: false,
      fits: 0,
      hasStaticCap: true,
      remaining: 1,
      staticCap: 1,
    });
    // Two spots sell one order, three spots still sell one, and an empty
    // pool sells none.
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: false,
      fits: 1,
      hasStaticCap: true,
      remaining: 2,
      staticCap: 10,
    });
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: false,
      fits: 1,
      hasStaticCap: true,
      remaining: 3,
      staticCap: 10,
    });
    expect(facts).toContainEqual({
      allowed: false,
      dateLess: false,
      fits: 0,
      hasStaticCap: true,
      remaining: 0,
      staticCap: 10,
    });
    // A tracked pool with no static cap sells on the remaining spots alone.
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: false,
      fits: 2,
      hasStaticCap: false,
      remaining: 5,
      staticCap: 0,
    });
  });

  test("names the data module the runner writes it to", async () => {
    const data = await sharedGroupCapacityModelData();
    // The runner writes the data to SharedGroupCapacityData.tla, and the
    // checker requires the module inside to carry the file's name.
    expect(data).toContain("---- MODULE SharedGroupCapacityData ----");
  });

  test("produces the pinned fact for every scenario, in order", () => {
    // Position on purpose: a changed scenario input that moves its output
    // fails here even when the moved output equals another scenario's.
    expect(FACTS).toEqual([
      // Shares no group at all, or shares only groups with no cap: either
      // way the pair contends over nothing and nothing refuses it.
      fact(true, true, 0, false, 0, 0),
      // Shares one capped group.
      fact(true, false, 2, true, 5, 10),
      // Takes the tightest of several shared groups.
      fact(true, false, 1, true, 2, 4),
      // Ignores the parent's own group the child never joins.
      fact(true, false, 2, true, 5, 10),
      // Ignores the child's tighter group the parent never joins.
      fact(true, false, 2, true, 5, 10),
      // Reads static cap and remaining from different shared groups.
      fact(true, false, 2, true, 5, 4),
      // Date-less pool with a static cap below two.
      fact(false, true, 0, true, 0, 1),
      // Pool below two spots.
      fact(false, false, 0, true, 1, 10),
      // Pool of exactly two spots.
      fact(true, false, 1, true, 2, 10),
      // Odd pool.
      fact(true, false, 1, true, 3, 10),
      // Empty pool.
      fact(false, false, 0, true, 0, 10),
      // Uncapped static group with tracked remaining.
      fact(true, false, 2, false, 5, 0),
      // Static cap below two with spots still free.
      fact(false, false, 2, true, 5, 1),
      // Uncapped static group with one spot left.
      fact(false, false, 0, false, 1, 0),
      // Static cap and remaining both below two.
      fact(false, false, 0, true, 1, 1),
      // Date-less pool with a static cap of ten.
      fact(true, true, 0, true, 0, 10),
    ]);
  });

  test("the overfill control inflates the fit ceiling of every date-full fact", async () => {
    const [honest, corrupted] = await factLists();
    expect(corrupted).toHaveLength(honest.length);
    honest.forEach((fact, index) => {
      const after = corrupted[index];
      expect(after).toEqual(
        fact.dateLess === true
          ? fact
          : { ...fact, fits: (fact.fits as number) + 1 },
      );
    });
  });

  test("the sold-out pair control allows only the refused date-less pair", async () => {
    const [honest] = await factLists();
    const corrupted = records(
      await dateLessSoldOutPairData(),
      "GroupFacts",
    ) as Fact[];
    const refused = (fact: Fact): boolean =>
      fact.dateLess === true &&
      fact.hasStaticCap === true &&
      (fact.staticCap as number) < PARENT_CHILD_GROUP_UNITS;
    expect(corrupted).toEqual(
      honest.map((fact) => (refused(fact) ? { ...fact, allowed: true } : fact)),
    );
  });
});
