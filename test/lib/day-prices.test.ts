import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  availableDayCounts,
  dayPriceFor,
  parseDayPrices,
} from "#shared/types.ts";
import { testListing } from "#test-utils";

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

  test("returns null for a non-customisable listing", () => {
    expect(
      dayPriceFor(
        testListing({ customisable_days: false, day_prices: { 1: 1000 } }),
        1,
      ),
    ).toBeNull();
  });
});
