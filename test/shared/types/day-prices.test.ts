import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { testListing } from "#test-utils/factories.ts";
import {
  ascending,
  availableDayCounts,
  clampDurationDays,
  DayPricesSchema,
  dayPriceFor,
  isPaidListing,
  MAX_DURATION_DAYS,
  parseDayPrices,
} from "#types";

describe("parseDayPrices", () => {
  test("keeps whole-number day counts mapped to whole-number minor prices", () => {
    expect(parseDayPrices({ 1: 1000, 2: 1800 })).toEqual({ 1: 1000, 2: 1800 });
  });

  test("parses string keys (as stored in JSON)", () => {
    expect(parseDayPrices({ "1": 1000, "3": 2500 })).toEqual({
      1: 1000,
      3: 2500,
    });
  });

  test("returns an empty map for non-object input", () => {
    expect(parseDayPrices(null)).toEqual({});
    expect(parseDayPrices("nope")).toEqual({});
  });

  test("drops day counts outside [1, MAX_DURATION_DAYS]", () => {
    expect(parseDayPrices({ 0: 500, 2: 1800, 91: 500 })).toEqual({ 2: 1800 });
  });

  test("drops non-integer day counts and prices", () => {
    expect(parseDayPrices({ 1.5: 1000, 2: 12.5, 3: 2000 })).toEqual({
      3: 2000,
    });
  });

  test("drops negative prices but keeps a zero (free) tier", () => {
    expect(parseDayPrices({ 1: -100, 2: 0 })).toEqual({ 2: 0 });
  });

  test("drops prices outside JavaScript's safe integer range", () => {
    expect(parseDayPrices({ 1: Number.MAX_SAFE_INTEGER + 1 })).toEqual({});
  });
});

describe("availableDayCounts", () => {
  test("is empty for a non-customisable listing", () => {
    const listing = testListing({
      customisable_days: false,
      day_prices: { 1: 1000 },
      duration_days: 3,
    });
    expect(availableDayCounts(listing)).toEqual([]);
  });

  test("returns priced counts within the maximum, sorted ascending", () => {
    const listing = testListing({
      customisable_days: true,
      day_prices: { 1: 1000, 2: 1800, 3: 2500 },
      duration_days: 3,
    });
    expect(availableDayCounts(listing)).toEqual([1, 2, 3]);
  });

  test("excludes priced counts above the maximum duration", () => {
    const listing = testListing({
      customisable_days: true,
      day_prices: { 1: 1000, 5: 4000 },
      duration_days: 3,
    });
    expect(availableDayCounts(listing)).toEqual([1]);
  });

  test("excludes a zero-day count, which is not a stay at all", () => {
    // parseDayPrices refuses a 0 key, so a stored listing never carries one.
    // The filter guards the other ways a listing reaches here — a hand-built
    // one in a test, or a row written before the parser existed.
    const listing = testListing({
      customisable_days: true,
      day_prices: { 0: 500, 1: 1000 },
      duration_days: 3,
    });
    expect(availableDayCounts(listing)).toEqual([1]);
  });
});

describe("ascending", () => {
  test("orders numbers smallest first, whatever order they arrive in", () => {
    // A comparator, so the contract is the sign it returns, not a sorted-
    // looking answer on input that was already sorted.
    expect([3, 10, 1, 2].sort(ascending)).toEqual([1, 2, 3, 10]);
  });

  test("says a smaller number comes first, a larger one after", () => {
    expect(ascending(1, 2)).toBeLessThan(0);
    expect(ascending(2, 1)).toBeGreaterThan(0);
    expect(ascending(2, 2)).toBe(0);
  });
});

describe("clampDurationDays", () => {
  test("keeps a count inside the supported range", () => {
    expect(clampDurationDays(1)).toBe(1);
    expect(clampDurationDays(MAX_DURATION_DAYS)).toBe(MAX_DURATION_DAYS);
  });

  test("pulls a count below one day up to a single day", () => {
    // A booking of zero days is not a booking, and the range starts at one.
    // Every reader of a stored duration goes through here, so the floor is
    // what stops a zero reaching the capacity SQL and reserving nothing.
    expect(clampDurationDays(0)).toBe(1);
    expect(clampDurationDays(-5)).toBe(1);
  });

  test("pulls a count above the supported range down to the maximum", () => {
    expect(clampDurationDays(MAX_DURATION_DAYS + 1)).toBe(MAX_DURATION_DAYS);
  });

  test("refuses a count that is not a whole number of days", () => {
    expect(() => clampDurationDays(1.5)).toThrow("Invalid booking duration");
  });
});

describe("DayPricesSchema", () => {
  const accepts = (value: unknown): boolean => v.is(DayPricesSchema, value);

  test("accepts whole-day counts inside the supported range", () => {
    expect(accepts({ "1": 1000, [String(MAX_DURATION_DAYS)]: 9000 })).toBe(
      true,
    );
  });

  test("refuses a day count above the supported range", () => {
    // The upper bound is the half a caller can break: the digits-only pattern
    // already rules out zero and negatives, so only this one needs guarding.
    expect(accepts({ [String(MAX_DURATION_DAYS + 1)]: 500 })).toBe(false);
  });

  test("refuses a day count that is not a positive whole number", () => {
    expect(accepts({ "0": 500 })).toBe(false);
    expect(accepts({ "1.5": 500 })).toBe(false);
  });
});

describe("dayPriceFor", () => {
  const listing = testListing({
    customisable_days: true,
    day_prices: { 1: 1000, 2: 1800 },
    duration_days: 3,
  });

  test("returns the configured price for an offered count", () => {
    expect(dayPriceFor(listing, 2)).toBe(1800);
  });

  test("returns null for a count with no configured price", () => {
    expect(dayPriceFor(listing, 3)).toBeNull();
  });

  test("returns null for a count outside [1, max]", () => {
    expect(dayPriceFor(listing, 0)).toBeNull();
    expect(dayPriceFor(listing, 4)).toBeNull();
  });

  test("returns null for a count below one even when it carries a price", () => {
    // Each refusal reason stands alone: a listing whose day_prices somehow
    // holds a 0 or a fraction must still be refused by the count check, not
    // by the absent-price fallback underneath it.
    const odd = testListing({
      customisable_days: true,
      day_prices: { 0: 500, 1: 1000 },
      duration_days: 3,
    });
    expect(dayPriceFor(odd, 0)).toBeNull();
  });

  test("returns null for a count that is not a whole number of days", () => {
    const fractional = testListing({
      customisable_days: true,
      day_prices: { 1.5: 700, 2: 1800 },
      duration_days: 3,
    });
    expect(dayPriceFor(fractional, 1.5)).toBeNull();
  });

  test("returns null for a count above the maximum even when priced", () => {
    const overlong = testListing({
      customisable_days: true,
      day_prices: { 2: 1800, 9: 5000 },
      duration_days: 3,
    });
    expect(dayPriceFor(overlong, 9)).toBeNull();
  });

  test("returns null for a non-customisable listing", () => {
    expect(
      dayPriceFor(
        testListing({ customisable_days: false, day_prices: { 1: 1000 } }),
        1,
      ),
    ).toBeNull();
  });
});

describe("isPaidListing", () => {
  test("is true for a flat-priced or pay-more listing", () => {
    expect(isPaidListing(testListing({ unit_price: 500 }))).toBe(true);
    expect(
      isPaidListing(testListing({ can_pay_more: true, unit_price: 0 })),
    ).toBe(true);
  });

  test("is true for the smallest price a listing can charge", () => {
    // One minor unit is still a price. The boundary matters because a listing
    // charging a penny must take payment, not be treated as free.
    expect(isPaidListing(testListing({ unit_price: 1 }))).toBe(true);
  });

  test("is true for a customisable listing with any non-zero day price", () => {
    const listing = testListing({
      customisable_days: true,
      day_prices: { 1: 0, 2: 1800 },
      unit_price: 0,
    });
    expect(isPaidListing(listing)).toBe(true);
  });

  test("is true for the smallest day price a listing can charge", () => {
    const listing = testListing({
      customisable_days: true,
      day_prices: { 1: 0, 2: 1 },
      unit_price: 0,
    });
    expect(isPaidListing(listing)).toBe(true);
  });

  test("is false for a free customisable listing (all day prices zero)", () => {
    const listing = testListing({
      customisable_days: true,
      day_prices: { 1: 0, 2: 0 },
      unit_price: 0,
    });
    expect(isPaidListing(listing)).toBe(false);
  });

  test("ignores day prices when the listing isn't customisable", () => {
    const listing = testListing({
      customisable_days: false,
      day_prices: { 1: 1000 },
      unit_price: 0,
    });
    expect(isPaidListing(listing)).toBe(false);
  });
});
