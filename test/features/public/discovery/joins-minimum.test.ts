/**
 * The add-on gate behind one child's label: whether the child can join a
 * booking that reaches the parent's minimum. The check reserves the child's
 * line and the parent line it folds under before asking the solver for the
 * rest, so a child whose pools cannot carry both lines reads as unable to
 * join even when the uncharged allocation reaches the minimum.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type ChildCapacityInfo,
  childJoinsMinimumBooking,
  evaluateParentPairs,
} from "#routes/public/discovery/combined-capacity.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { useSetting } from "#test-utils/settings.ts";
import type { ListingWithCount } from "#types";

const GROUP = 10;

/** A minimum-3 parent with three places left in capped group 10. */
const parent = (overrides: Partial<ListingWithCount> = {}): ListingWithCount =>
  testListingWithCount({
    id: 1,
    listing_type: "standard",
    max_attendees: 5,
    max_quantity: 5,
    min_quantity: 3,
    name: "Batched base",
    ...overrides,
  }) as ListingWithCount;

const capsFor = (
  childOwnRemaining: ReadonlyMap<number, number>,
): ChildCapacityInfo => ({
  childOwnRemaining,
  membership: new Map([
    [1, [GROUP, 99]],
    [2, [GROUP]],
    [3, []],
    [4, []],
  ]),
  remainingByGroupId: new Map([[GROUP, 3]]),
  staticCapByGroupId: new Map([[GROUP, 3]]),
});

/** The gate's answer for the first of `children` under `parent`, with the
 *  pair evaluated the way discovery evaluates it. */
const joinsOver = (
  parent: ListingWithCount,
  children: readonly ListingWithCount[],
  childOwnRemaining: ReadonlyMap<number, number>,
): boolean => {
  const caps = capsFor(childOwnRemaining);
  const evaluations = evaluateParentPairs({
    caps,
    children,
    holidays: [],
    parent,
  });
  return childJoinsMinimumBooking(parent, children[0]!, caps, [], evaluations);
};

describeWithEnv("childJoinsMinimumBooking", { db: true }, () => {
  useSetting({ timezone: "UTC" });

  test("refuses a standard child whose shared pool cannot carry it and the parent's minimum", () => {
    // The parent's three lines take all three of group 10's places, so the
    // target's own line has nowhere to go. The uncharged allocation still
    // reaches three — the free child outside the pool serves every line —
    // and the target can serve one line alone, but a booking that includes
    // the target needs four places in a three-place pool.
    const target = testListingWithCount({
      id: 2,
      listing_type: "standard",
      max_attendees: 1,
      max_quantity: 1,
      min_quantity: 1,
      name: "Shared pool add-on",
    }) as ListingWithCount;
    const free = testListingWithCount({
      id: 3,
      listing_type: "standard",
      max_attendees: 3,
      max_quantity: 3,
      min_quantity: 1,
      name: "Free add-on",
    }) as ListingWithCount;

    expect(
      joinsOver(
        parent(),
        [target, free],
        new Map([
          [2, 1],
          [3, 3],
        ]),
      ),
    ).toBe(false);
  });

  test("judges a daily child's reserved line beside its paired parent line", () => {
    // The pool holds three places: three parent lines plus the child's own
    // line need four. Reserving the child's line alone undercharges the
    // pools by the paired parent line and read the child as able to join.
    const daily = (
      id: number,
      maxQuantity: number,
      name: string,
    ): ListingWithCount =>
      testListingWithCount({
        bookable_days: [...VALID_DAY_NAMES],
        id,
        listing_type: "daily",
        max_attendees: maxQuantity,
        max_quantity: maxQuantity,
        maximum_days_after: 10,
        min_quantity: 1,
        minimum_days_before: 0,
        name,
      }) as ListingWithCount;
    const base = parent({
      bookable_days: [...VALID_DAY_NAMES],
      listing_type: "daily",
      maximum_days_after: 10,
      minimum_days_before: 0,
    });
    const target = daily(2, 1, "Shared pool add-on");
    const free = daily(3, 3, "Free add-on");

    expect(
      joinsOver(
        base,
        [target, free],
        new Map([
          [2, 1],
          [3, 3],
        ]),
      ),
    ).toBe(false);
  });

  test("reads a child its parent's evaluation omits as unable to join", () => {
    // A displayed child whose parent's evaluation carries no ceiling for it
    // has no pair to fold on, so the gate answers false instead of crashing.
    const other = testListingWithCount({
      id: 3,
      listing_type: "standard",
      max_attendees: 3,
      max_quantity: 3,
      min_quantity: 1,
      name: "Free add-on",
    }) as ListingWithCount;
    const absent = testListingWithCount({
      id: 4,
      listing_type: "standard",
      max_attendees: 5,
      max_quantity: 5,
      min_quantity: 1,
      name: "Unlinked add-on",
    }) as ListingWithCount;
    const caps = capsFor(
      new Map([
        [3, 3],
        [4, 5],
      ]),
    );
    const evaluations = evaluateParentPairs({
      caps,
      children: [other],
      holidays: [],
      parent: parent(),
    });

    expect(
      childJoinsMinimumBooking(parent(), absent, caps, [], evaluations),
    ).toBe(false);
  });
});
