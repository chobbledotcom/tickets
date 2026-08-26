/**
 * Pure unit tests for the small shared helpers `types.ts` exports: the
 * record guard, the paid/ticket predicates, the day-price readers, and the
 * shared-group capacity fold. Deterministic — no DB or harness.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ascending,
  availableDayCounts,
  clampDurationDays,
  DayPricesSchema,
  dayPriceFor,
  hasTicketQuantity,
  isPaidListing,
  isRecord,
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupCapacity,
  sharedGroupRemaining,
} from "#types";

describe("isRecord", () => {
  test("accepts a plain object and rejects null, arrays, and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("object")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe("isPaidListing", () => {
  const base = {
    can_pay_more: false,
    customisable_days: false,
    day_prices: {},
  };

  test("a flat price of one minor unit makes the listing paid", () => {
    expect(isPaidListing({ ...base, unit_price: 1 })).toBe(true);
  });

  test("pay-more alone makes the listing paid at a zero price", () => {
    expect(isPaidListing({ ...base, can_pay_more: true, unit_price: 0 })).toBe(
      true,
    );
  });

  test("a single priced day makes a customisable listing paid", () => {
    expect(
      isPaidListing({
        ...base,
        customisable_days: true,
        day_prices: { 2: 1 },
        unit_price: 0,
      }),
    ).toBe(true);
  });

  test("nothing priced leaves the listing free", () => {
    expect(
      isPaidListing({
        ...base,
        customisable_days: true,
        day_prices: { 2: 0 },
        unit_price: 0,
      }),
    ).toBe(false);
  });
});

describe("hasTicketQuantity", () => {
  test("one is a real ticket and the zero sentinel is not", () => {
    expect(hasTicketQuantity({ quantity: 1 })).toBe(true);
    expect(hasTicketQuantity({ quantity: 0 })).toBe(false);
  });
});

describe("clampDurationDays", () => {
  test("clamps a too-small count up to one day", () => {
    expect(clampDurationDays(0)).toBe(1);
  });
});

describe("DayPricesSchema", () => {
  test("accepts day counts of one and the maximum with a zero price", () => {
    expect(v.is(DayPricesSchema, { 1: 0, 90: 500 })).toBe(true);
  });

  test("rejects counts outside the supported range", () => {
    expect(v.is(DayPricesSchema, { 91: 500 })).toBe(false);
    expect(v.is(DayPricesSchema, { 0: 500 })).toBe(false);
  });
});

describe("ascending", () => {
  test("sorts numbers smallest first", () => {
    expect([3, 1, 2].sort(ascending)).toEqual([1, 2, 3]);
    expect(ascending(5, 2)).toBe(3);
  });
});

const customisable: {
  customisable_days: boolean;
  day_prices: Record<number, number>;
  duration_days: number;
} = {
  customisable_days: true,
  day_prices: { 2: 0, 3: 400, 5: 600 },
  duration_days: 3,
};

describe("availableDayCounts", () => {
  test("lists offered counts up to the duration, smallest first", () => {
    // The 5-day price stays stored but the duration has since shrunk to 3,
    // so only 2 and 3 remain offerable.
    expect(availableDayCounts(customisable)).toEqual([2, 3]);
  });

  test("a non-customisable listing offers nothing", () => {
    expect(
      availableDayCounts({
        customisable_days: false,
        day_prices: { 2: 300 },
        duration_days: 3,
      }),
    ).toEqual([]);
  });
});

describe("dayPriceFor", () => {
  test("returns the price for an offered whole-day count, zero included", () => {
    expect(dayPriceFor(customisable, 3)).toBe(400);
    expect(dayPriceFor(customisable, 2)).toBe(0);
  });

  test("returns null past the duration even when a price is still stored", () => {
    expect(dayPriceFor(customisable, 5)).toBeNull();
  });

  test("returns null for fractional counts and non-customisable listings", () => {
    expect(dayPriceFor(customisable, 1.5)).toBeNull();
    expect(
      dayPriceFor({ ...customisable, customisable_days: false }, 3),
    ).toBeNull();
  });
});

describe("shared capped groups", () => {
  test("a parent and child with no shared capped group have no remaining", () => {
    // Group 1 is capped but only the parent is in it; group 2 holds the child.
    expect(
      sharedGroupRemaining(
        [1],
        [2],
        new Map([
          [1, 5],
          [2, 4],
        ]),
      ),
    ).toBeUndefined();
    expect(
      sharedGroupCapacity([1], [2], new Map([[1, 6]]), new Map([[1, 5]])),
    ).toEqual({ remaining: undefined, staticCap: undefined });
  });

  test("one shared capped group reports its remaining spots", () => {
    expect(sharedGroupRemaining([1], [1], new Map([[1, 5]]))).toBe(5);
    expect(
      sharedGroupCapacity([1], [1], new Map([[1, 6]]), new Map([[1, 5]])),
    ).toEqual({ remaining: 5, staticCap: 6 });
  });

  test("the tightest shared group wins over a tighter unshared one", () => {
    expect(
      sharedGroupRemaining(
        [1],
        [1, 2],
        new Map([
          [1, 5],
          [2, 1],
        ]),
      ),
    ).toBe(5);
    expect(
      sharedGroupCapacity(
        [1],
        [1, 2],
        new Map([
          [1, 6],
          [2, 2],
        ]),
        new Map([
          [1, 5],
          [2, 1],
        ]),
      ),
    ).toEqual({ remaining: 5, staticCap: 6 });
  });
});

describe("PARENT_CHILD_GROUP_UNITS", () => {
  test("a parent plus its required child take two group spots", () => {
    expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
  });
});
