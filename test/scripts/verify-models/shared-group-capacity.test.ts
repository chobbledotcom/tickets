/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
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

  test("records the production outputs for every scenario branch", async () => {
    const [facts] = await factLists();
    expect(facts).toContainEqual({
      allowed: true,
      dateLess: false,
      fits: 2,
      hasStaticCap: true,
      remaining: 5,
      staticCap: 10,
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
    // A pool of one spot fits no whole parent+child order.
    expect(facts).toContainEqual({
      allowed: false,
      dateLess: false,
      fits: 0,
      hasStaticCap: true,
      remaining: 1,
      staticCap: 10,
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
});
