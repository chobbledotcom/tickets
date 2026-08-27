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
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupCapacity,
  sharedGroupRemaining,
} from "#types";

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
