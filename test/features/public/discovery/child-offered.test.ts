/**
 * Direct tests for the per-date child fold gate: which child listings can
 * fold under a parent ticket that starts on one exact date.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { TicketListing } from "#booking/model.ts";
import { childOfferedOnDate } from "#routes/public/discovery/child-offered.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { resolved, today } from "#test-utils/booking-model-fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { useSetting } from "#test-utils/settings.ts";

/** A standalone (non-daily) child whose stock the caller reads directly. */
const stockChild = (soldOut: boolean): TicketListing =>
  ({
    ...resolved(testListingWithCount({ listing_type: "standard" })),
    isSoldOut: soldOut,
    maxPurchasable: 3,
  }) as TicketListing;

/** A daily child bookable every day inside a ten-day window. */
const dailyChild = (
  overrides: Parameters<typeof testListingWithCount>[0] = {},
): TicketListing =>
  ({
    ...resolved(
      testListingWithCount({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 0,
        ...overrides,
      }),
    ),
    isSoldOut: false,
    maxPurchasable: 3,
  }) as TicketListing;

describeWithEnv("childOfferedOnDate", { db: true }, () => {
  // The calendar rules read the site timezone; pin it so `today()` is the
  // same day the window bounds use.
  useSetting({ timezone: "UTC" });

  test("a non-daily child folds on stock alone", () => {
    expect(childOfferedOnDate(stockChild(false), [], [1], [], today())).toBe(
      true,
    );
    expect(childOfferedOnDate(stockChild(true), [], [1], [], today())).toBe(
      false,
    );
  });

  test("a daily child that cannot start on the date folds on no date", () => {
    const child = dailyChild();
    expect(childOfferedOnDate(child, [], [1], [today()], today())).toBe(true);
    expect(childOfferedOnDate(child, [], [1], [today()], "2020-01-01")).toBe(
      false,
    );
  });

  test("a daily child folds when an offered span books on the date", () => {
    const child = dailyChild();
    // The parent offers two- and three-day spans; the two-day one books.
    expect(childOfferedOnDate(child, [], [2, 3], [today()], today())).toBe(
      true,
    );
  });

  test("a daily child folds on no span when every offered span leaves the window", () => {
    const child = dailyChild({ maximum_days_after: 2 });
    expect(childOfferedOnDate(child, [], [5], [today()], today())).toBe(false);
  });

  test("a missing day count books the one-day span", () => {
    const child = dailyChild();
    // A null count is the date-less parent's entry: the child books one day.
    expect(
      childOfferedOnDate(
        child,
        [],
        [null as unknown as number],
        [today()],
        today(),
      ),
    ).toBe(true);
  });
});
