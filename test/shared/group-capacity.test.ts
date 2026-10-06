/**
 * The pure capacity maths for a parent and one of its children that share a
 * capped group. Every surface that asks "does this combined order fit?" goes
 * through these, so an off-by-one here either oversells a group or hides a
 * listing that still has room.
 *
 * Direct unit tests, because the integration suites that exercise these run
 * only when they themselves change, and a branch that touches `types.ts` needs
 * cover that runs against it every time.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  combinedChildCapacityForParent,
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupCapacity,
  sharedGroupRemaining,
} from "#shared/group-capacity.ts";

/** A per-group map, written the way the callers build one: only capped groups
 * appear, so absence means "this group has no cap". */
const byGroup = (
  entries: Record<number, number>,
): ReadonlyMap<number, number> =>
  new Map(Object.entries(entries).map(([id, spots]) => [Number(id), spots]));

describe("PARENT_CHILD_GROUP_UNITS", () => {
  test("is two: the parent line and its one required child line", () => {
    // Every "how many whole orders fit?" division uses this. A different
    // number would let a pool of one spot look like it holds a whole order.
    expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
  });
});

describe("sharedGroupRemaining", () => {
  test("is undefined when the two share no group at all", () => {
    expect(sharedGroupRemaining([1], [2], byGroup({ 1: 5, 2: 5 }))).toBe(
      undefined,
    );
  });

  test("is undefined when the group they share has no cap", () => {
    // An uncapped group is absent from the map, so there is no pool to contend
    // over and nothing to report.
    expect(sharedGroupRemaining([7], [7], byGroup({}))).toBe(undefined);
  });

  test("is the free spots of the one capped group they share", () => {
    expect(sharedGroupRemaining([7], [7], byGroup({ 7: 5 }))).toBe(5);
  });

  test("is the tightest of several shared capped groups", () => {
    expect(sharedGroupRemaining([7, 8], [7, 8], byGroup({ 7: 5, 8: 2 }))).toBe(
      2,
    );
  });

  test("ignores a capped group only one of them belongs to", () => {
    // The parent's own capped group is not a pool the pair contends over. A
    // check that accepted it would report a cap from a group the child never
    // takes a spot in.
    expect(sharedGroupRemaining([1, 7], [7], byGroup({ 1: 0, 7: 5 }))).toBe(5);
  });

  test("ignores the child's tighter group when it is not shared", () => {
    expect(sharedGroupRemaining([7], [7, 9], byGroup({ 7: 5, 9: 1 }))).toBe(5);
  });
});

describe("sharedGroupCapacity", () => {
  test("reports neither fact when the two share no capped group", () => {
    expect(
      sharedGroupCapacity(
        [1],
        [2],
        byGroup({ 1: 10, 2: 10 }),
        byGroup({ 1: 3 }),
      ),
    ).toEqual({ remaining: undefined, staticCap: undefined });
  });

  test("reports both facts from the one capped group they share", () => {
    expect(
      sharedGroupCapacity([7], [7], byGroup({ 7: 10 }), byGroup({ 7: 3 })),
    ).toEqual({ remaining: 3, staticCap: 10 });
  });

  test("reports the tightest of several shared capped groups", () => {
    expect(
      sharedGroupCapacity(
        [7, 8],
        [7, 8],
        byGroup({ 7: 10, 8: 4 }),
        byGroup({ 7: 3, 8: 1 }),
      ),
    ).toEqual({ remaining: 1, staticCap: 4 });
  });

  test("takes neither fact from a tighter group only the child is in", () => {
    // The child's own tighter group must not drag the shared pool down: the
    // parent never takes a spot in it, so it caps nothing they contend over.
    expect(
      sharedGroupCapacity(
        [7],
        [7, 9],
        byGroup({ 7: 10, 9: 1 }),
        byGroup({ 7: 3, 9: 1 }),
      ),
    ).toEqual({ remaining: 3, staticCap: 10 });
  });

  test("reports a static cap while the free spots are unknown", () => {
    // A daily child with no submitted date has no per-date remaining, so that
    // group is absent from the remaining map. The structural ceiling still
    // says whether the pair can ever fit.
    expect(
      sharedGroupCapacity([7], [7], byGroup({ 7: 1 }), byGroup({})),
    ).toEqual({ remaining: undefined, staticCap: 1 });
  });
});

/** One child's part in the brute-force check, mirroring the caller-side part:
 *  the group ids and the units ceiling. */
type BruteChild = { groupIds: number[]; ownMax: number };

/** Whether placing `units` lines of one child keeps every shared pool within
 *  its places, with the parent's own `t` places already spent. */
const bruteUnitsFit = (
  pools: readonly number[],
  spent: ReadonlyMap<number, number>,
  remaining: ReadonlyMap<number, number>,
  parentGroupIds: readonly number[],
  t: number,
  units: number,
): boolean =>
  pools.every(
    (groupId) =>
      (spent.get(groupId) ?? 0) + units <=
      (remaining.get(groupId) ?? 0) -
        (parentGroupIds.includes(groupId) ? t : 0),
  );

/** Whether a split of `left` child lines over the children from `index` on
 *  keeps every shared pool within its places, with the parent's own `t`
 *  places spent. Zero units always fit: a child can sit a ticket out. */
const bruteSplitWorks = (
  children: readonly BruteChild[],
  poolsOf: (child: BruteChild) => number[],
  remaining: ReadonlyMap<number, number>,
  parentGroupIds: readonly number[],
  index: number,
  left: number,
  spent: ReadonlyMap<number, number>,
  t: number,
): boolean => {
  if (index === children.length) return left === 0;
  const child = children[index]!;
  const pools = poolsOf(child);
  for (let units = 0; units <= Math.min(child.ownMax, left); units++) {
    if (
      units > 0 &&
      !bruteUnitsFit(pools, spent, remaining, parentGroupIds, t, units)
    ) {
      continue;
    }
    const nextSpent = new Map(spent);
    for (const groupId of pools) {
      nextSpent.set(groupId, (nextSpent.get(groupId) ?? 0) + units);
    }
    if (
      bruteSplitWorks(
        children,
        poolsOf,
        remaining,
        parentGroupIds,
        index + 1,
        left - units,
        nextSpent,
        t,
      )
    ) {
      return true;
    }
  }
  return false;
};

/** The definition, brute force: the largest quantity whose child lines have a
 *  split that keeps every shared pool within its places. The parent's own
 *  spend binds only the pools it shares with a child that can still serve a
 *  line; pools only the parent sits in belong to the caller's parent
 *  ceiling, and a child's own pools are baked into its ownMax. */
const bruteForceCombinedCapacity = (
  parentGroupIds: readonly number[],
  children: readonly BruteChild[],
  remaining: ReadonlyMap<number, number>,
): number => {
  const poolsOf = (child: BruteChild): number[] =>
    parentGroupIds.filter(
      (groupId) => child.groupIds.includes(groupId) && remaining.has(groupId),
    );
  const sharedPools = [
    ...new Set(
      children
        .filter((child) => child.ownMax > 0)
        .flatMap((child) => poolsOf(child)),
    ),
  ];
  for (let t = 12; t > 0; t--) {
    const parentFits = sharedPools.every(
      (groupId) => (remaining.get(groupId) ?? 0) >= t,
    );
    if (
      parentFits &&
      bruteSplitWorks(
        children,
        poolsOf,
        remaining,
        parentGroupIds,
        0,
        t,
        new Map(),
        t,
      )
    ) {
      return t;
    }
  }
  return 0;
};

describe("combinedChildCapacityForParent", () => {
  test("sums the children's own ceilings when they share no capped group", () => {
    expect(
      combinedChildCapacityForParent(
        [7],
        [
          { groupIds: [8], ownMax: 2 },
          { groupIds: [], ownMax: 1 },
        ],
        byGroup({ 8: 100 }),
      ),
    ).toBe(3);
  });

  test("bounds children sharing one pool once, not once per child", () => {
    // Two children in the same pool of four spots: two whole pairs fit, so
    // together they serve two parent tickets, never the sum of their
    // ceilings (four).
    expect(
      combinedChildCapacityForParent(
        [7],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [7], ownMax: 2 },
        ],
        byGroup({ 7: 4 }),
      ),
    ).toBe(2);
  });

  test("bounds a pool across children whose shared sets merely overlap", () => {
    // One child uses pool A alone, the other pools A and B. Both draw pairs
    // from A, so A bounds their total even though the children partition
    // into different shared sets.
    expect(
      combinedChildCapacityForParent(
        [7, 8],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [7, 8], ownMax: 2 },
        ],
        byGroup({ 7: 4, 8: 4 }),
      ),
    ).toBe(2);
  });

  test("ignores a shared pool whose remaining is unknown", () => {
    // Only capped groups with a known remaining enter the bound: a daily
    // child's pool with no submitted date bounds nothing here, and the
    // submit fold decides.
    expect(
      combinedChildCapacityForParent(
        [7],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [7], ownMax: 2 },
        ],
        byGroup({}),
      ),
    ).toBe(4);
  });

  test("serves two, not four, when each child draws a different pool", () => {
    // The parent takes one place in both pools per ticket: at three tickets
    // only one child place is left in each pool, so the three child lines the
    // tickets need cannot all be placed. Two tickets fit: two child lines
    // through each pool.
    expect(
      combinedChildCapacityForParent(
        [7, 8],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [8], ownMax: 2 },
        ],
        byGroup({ 7: 4, 8: 4 }),
      ),
    ).toBe(2);
  });

  test("spares children that do not use a tight pool", () => {
    // The parent's two pool places go to two tickets whose child lines both
    // ride the child outside the tight pool; that child's ceiling (three)
    // covers both lines. The tight pool's own ceiling holds the parent to
    // two tickets, and the child inside it can sit them out.
    expect(
      combinedChildCapacityForParent(
        [7],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [8], ownMax: 3 },
        ],
        byGroup({ 7: 2, 8: 100 }),
      ),
    ).toBe(2);
  });

  test("matches a brute-force allocator on random small graphs", () => {
    // The generator is a fixed-seed LCG so a failure names the same graphs on
    // every run.
    const seed = 0x2f6e2b1;
    let state = seed;
    const next = (bound: number): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) & 0x7fffffff;
      return state % bound;
    };
    for (let round = 0; round < 300; round++) {
      const poolCount = 1 + next(3);
      const remaining = new Map<number, number>(
        Array.from({ length: poolCount }, (_, index) => [index + 1, next(7)]),
      );
      const parentGroupIds = Array.from({ length: poolCount }, (_, index) =>
        next(2) === 0 ? index + 1 : 0,
      ).filter((groupId) => groupId > 0);
      if (parentGroupIds.length === 0) parentGroupIds.push(1);
      const childCount = next(4);
      const children = Array.from({ length: childCount }, () => {
        const groupIds = Array.from({ length: poolCount + 1 }, (_, index) =>
          next(2) === 0 ? index + 1 : 0,
        ).filter((groupId) => groupId > 0);
        return { groupIds, ownMax: next(4) };
      });
      const exact = combinedChildCapacityForParent(
        parentGroupIds,
        children,
        remaining,
      );
      const brute = bruteForceCombinedCapacity(
        parentGroupIds,
        children,
        remaining,
      );
      expect(
        `round ${round}: pools ${JSON.stringify([...remaining])} parent ${JSON.stringify(parentGroupIds)} children ${JSON.stringify(children)}: exact ${exact} brute ${brute}`,
      ).toBe(
        `round ${round}: pools ${JSON.stringify([...remaining])} parent ${JSON.stringify(parentGroupIds)} children ${JSON.stringify(children)}: exact ${brute} brute ${brute}`,
      );
    }
  });
});
