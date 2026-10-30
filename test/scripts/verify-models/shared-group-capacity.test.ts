/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  dateLessSoldOutPairData,
  overfillCapacityData,
  sharedGroupCapacityModelData,
} from "#scripts/verify-models/shared-group-capacity.ts";
import { PARENT_CHILD_GROUP_UNITS } from "#shared/group-capacity.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type Fact = Record<string, string | boolean | number>;

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
    // Seventeen scenarios collapse to fourteen distinct facts: three produce
    // the plain capped pool and two produce the no-group fact.
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
