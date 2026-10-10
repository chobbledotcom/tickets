/**
 * Direct tests for one required child's date capacity in the daily date
 * filter: the most units the child can serve on one exact date, after its
 * own gates.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type ChildDateCapacityCtx,
  childDateCapacity,
} from "#routes/public/discovery/child-date-capacity.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { today } from "#test-utils/booking-model-fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { useSetting } from "#test-utils/settings.ts";
import type { ListingWithCount } from "#types";

// The calendar rules read the site timezone; pin it so `today()` is the
// same day the window bounds use.
describeWithEnv("childDateCapacity", { db: true }, () => {
  useSetting({ timezone: "UTC" });

  /** A daily child bookable every day inside a ten-day window, selling at
   *  most five per purchase. The function reads the raw listing, as
   *  production passes it from the parent links. */
  const dailyChild = (): ListingWithCount =>
    testListingWithCount({
      bookable_days: [...VALID_DAY_NAMES],
      id: 1,
      listing_type: "daily",
      max_attendees: 5,
      max_quantity: 5,
      maximum_days_after: 10,
      minimum_days_before: 0,
    }) as ListingWithCount;

  const ctx = (remaining: number): ChildDateCapacityCtx => ({
    date: today(),
    dayCounts: [1],
    holidays: [],
    remaining: new Map([[1, remaining]]),
  });

  test("an inactive child serves none, whatever its places", () => {
    const child = {
      ...dailyChild(),
      active: false,
    } as ListingWithCount;
    expect(childDateCapacity(child, ctx(9))).toBe(0);
  });

  test("a closed child serves none", () => {
    const child = {
      ...dailyChild(),
      closes_at: "2020-01-01T00:00:00.000Z",
    } as ListingWithCount;
    expect(childDateCapacity(child, ctx(9))).toBe(0);
  });

  test("an active open daily child serves its places on a startable date", () => {
    // Five places left on the child and five per purchase: the fold takes
    // the child's own ceiling, not the nine remaining.
    expect(childDateCapacity(dailyChild(), ctx(9))).toBe(5);
  });

  test("a daily child that cannot start on the date serves none", () => {
    const child = dailyChild();
    const ctxOff: ChildDateCapacityCtx = { ...ctx(9), date: "2020-01-01" };
    expect(childDateCapacity(child, ctxOff)).toBe(0);
  });
});
