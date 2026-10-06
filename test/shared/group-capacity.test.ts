/**
 * The exact combined-capacity search: how many whole parent tickets a
 * parent's required children can serve together.
 *
 * Direct unit tests, because the surfaces that exercise the search render
 * whole pages, and a bound or a prune that answers one too high oversells a
 * group on every page that reads it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  childCapacityPartsFor,
  combinedChildCapacityForParent,
} from "#shared/capacity-fit.ts";
import { byGroup } from "#test-utils/by-group-map.ts";

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
 *  split that keeps every pool the children draw from within its places. The
 *  parent's own spend lands only on the pools it belongs to; pools only the
 *  parent sits in belong to the caller's parent ceiling. */
const bruteForceCombinedCapacity = (
  parentGroupIds: readonly number[],
  children: readonly BruteChild[],
  remaining: ReadonlyMap<number, number>,
): number => {
  const poolsOf = (child: BruteChild): number[] =>
    child.groupIds.filter((groupId) => remaining.has(groupId));
  const ledgerPools = [
    ...new Set(
      children
        .filter((child) => child.ownMax > 0)
        .flatMap((child) => poolsOf(child)),
    ),
  ];
  for (let t = 12; t > 0; t--) {
    const parentFits = ledgerPools.every(
      (groupId) =>
        !parentGroupIds.includes(groupId) || (remaining.get(groupId) ?? 0) >= t,
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

describe("childCapacityPartsFor", () => {
  test("reads each child's groups from the one lookup and its ceiling from its own source", () => {
    const child = { id: 11, places: 4 };
    expect(
      childCapacityPartsFor(
        new Map([[11, [7, 8]]]),
        [child],
        (c) => c.id,
        (c) => c.places,
      ),
    ).toEqual([{ groupIds: [7, 8], ownMax: 4 }]);
  });

  test("gives a child absent from the lookup no pools", () => {
    // A listing that belongs to no group cannot draw from any pool, so an
    // absent entry reads as an empty set, not as unknown.
    const child = { id: 12, places: 2 };
    expect(
      childCapacityPartsFor(
        new Map(),
        [child],
        (c) => c.id,
        (c) => c.places,
      ),
    ).toEqual([{ groupIds: [], ownMax: 2 }]);
  });
});

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

  test("refuses a count the flow bound passes but no split can place", () => {
    // Both children draw both pools, and each pool holds five places with
    // the parent spending three: the residuals (two each) pass the flow
    // bound for three lines, but the largest child's room (two) leaves one
    // line the smaller child cannot place in pools it has already emptied.
    // The exact search refuses it and answers two.
    expect(
      combinedChildCapacityForParent(
        [7, 8],
        [
          { groupIds: [7, 8], ownMax: 4 },
          { groupIds: [7, 8], ownMax: 2 },
        ],
        byGroup({ 7: 5, 8: 5 }),
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

  test("answers six hundred sixty six on large pools without walking every count", () => {
    // Two pools of a thousand places, the parent in both, two children of
    // five hundred each in one pool apiece. At t tickets each pool holds t
    // parent places and 1000 - t child places, and the two children can
    // place 2 × min(500, 1000 - t) lines, so the last feasible t is 666.
    // A walk down from a thousand would retry every failing count from the
    // top; the search answers in a handful of checks.
    const started = performance.now();
    expect(
      combinedChildCapacityForParent(
        [7, 8],
        [
          { groupIds: [7], ownMax: 500 },
          { groupIds: [8], ownMax: 500 },
        ],
        byGroup({ 7: 1000, 8: 1000 }),
      ),
    ).toBe(666);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("does not let a multi-pool child split one unit across its pools", () => {
    // A child's unit takes one place in EVERY pool the child belongs to.
    // The child below sits in pools A and B, holds two units of its own,
    // and pool B has nothing left: the child can serve nothing, even though
    // a flow that lets one unit travel through pool A alone would answer
    // two. The flow bound only rejects; the exact split decides.
    expect(
      combinedChildCapacityForParent(
        [7, 8],
        [
          { groupIds: [7, 8], ownMax: 2 },
          { groupIds: [7], ownMax: 0 },
        ],
        byGroup({ 7: 4, 8: 0 }),
      ),
    ).toBe(0);
  });

  test("lets a child sit a ticket out so a later child can carry the line", () => {
    // Pool A has almost nothing left, so the largest child — the only one
    // that draws from it — sits both tickets out, and the second child
    // carries both lines through pool B on its own.
    expect(
      combinedChildCapacityForParent(
        [7, 8],
        [
          { groupIds: [7], ownMax: 3 },
          { groupIds: [8], ownMax: 2 },
        ],
        byGroup({ 7: 2, 8: 4 }),
      ),
    ).toBe(2);
  });

  test("refuses a quantity no child order can complete", () => {
    // Every child draws pool A alone, so t tickets need t lines through a
    // pool with room for fewer after the parent's own places. No split can
    // finish, and the search must say so rather than answer a partial one.
    expect(
      combinedChildCapacityForParent(
        [7],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [7], ownMax: 2 },
        ],
        byGroup({ 7: 5 }),
      ),
    ).toBe(2);
  });

  test("serves two, not four, when only the children share a pool", () => {
    // The parent sits outside the capped group, so neither child shares a
    // pool with it — but both children draw from the same group with two
    // places left. Each child line takes one of them, so the children can
    // serve two parent tickets, never the sum of their ceilings (four), and
    // a minimum of three must read unservable.
    expect(
      combinedChildCapacityForParent(
        [],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [7], ownMax: 2 },
        ],
        byGroup({ 7: 2 }),
      ),
    ).toBe(2);
  });

  test("binds a child-only pool and spares it the parent's spend", () => {
    // Child two draws pool A with the parent AND a child-only pool B with
    // one place left. B bounds child two to one line, so the children serve
    // three tickets, not four. B never holds the parent, so the parent's
    // tickets must not subtract from it — charging the parent there would
    // answer two.
    expect(
      combinedChildCapacityForParent(
        [7],
        [
          { groupIds: [7], ownMax: 2 },
          { groupIds: [7, 8], ownMax: 2 },
        ],
        byGroup({ 7: 10, 8: 1 }),
      ),
    ).toBe(3);
  });

  test("answers eight with thirty children on two tight pools without walking every split", () => {
    // Thirty one-unit children all drawing two child-only pools of eight
    // places each: the flow bound sums the pools (sixteen) and accepts a
    // need of fifteen, while every line takes one place in BOTH pools, so
    // eight is the most the children can serve. The include/exclude walk
    // retries millions of splits for that midpoint; the memoised walk visits
    // each (child, owed, pool levels) state once.
    const children = Array.from({ length: 30 }, () => ({
      groupIds: [7, 8],
      ownMax: 1,
    }));
    const started = performance.now();
    expect(
      combinedChildCapacityForParent([], children, byGroup({ 7: 8, 8: 8 })),
    ).toBe(8);
    // The unbounded walk spends seconds on one date-less evaluation; a daily
    // parent repeats it per offered date, so the bound has to hold with room
    // for a whole request.
    expect(performance.now() - started).toBeLessThan(1000);
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
