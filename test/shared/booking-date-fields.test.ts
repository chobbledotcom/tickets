import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bookingDateFields } from "#shared/booking-date-fields.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("bookingDateFields", () => {
  test("standard non-customisable booking spans a single dateless day", () => {
    const listing = testListingWithCount({ listing_type: "standard" });
    expect(bookingDateFields(listing, null, 3)).toEqual({
      date: null,
      durationDays: 1,
    });
  });

  test("daily non-customisable booking uses the listing's fixed duration", () => {
    const listing = testListingWithCount({
      duration_days: 4,
      listing_type: "daily",
    });
    expect(bookingDateFields(listing, "2026-07-01", 2)).toEqual({
      date: "2026-07-01",
      durationDays: 4,
    });
  });

  test("customisable daily booking spans the chosen day count", () => {
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000, 3: 2500 },
      duration_days: 5,
      listing_type: "daily",
    });
    expect(bookingDateFields(listing, "2026-07-01", 3)).toEqual({
      date: "2026-07-01",
      durationDays: 3,
    });
  });

  test("customisable standard booking carries the day count but no date", () => {
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 2: 1800 },
      duration_days: 3,
      listing_type: "standard",
    });
    expect(bookingDateFields(listing, null, 2)).toEqual({
      date: null,
      durationDays: 2,
    });
  });

  test("a customisable listing with a missing day count spans one day", () => {
    // A legacy signed session without day_count reaches the builder with no
    // day count; the default must mean one day (not the listing's maximum),
    // so a row never silently books the whole configurable span.
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000, 3: 2500 },
      duration_days: 5,
      listing_type: "daily",
    });
    expect(bookingDateFields(listing, "2026-07-01")).toEqual({
      date: "2026-07-01",
      durationDays: 1,
    });
  });

  test("clamps a zero day count back to one day", () => {
    // The clamp's Math.max(1, …) turns 0 into the same one-day span the
    // default day count produces.
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000 },
      duration_days: 5,
      listing_type: "daily",
    });
    expect(bookingDateFields(listing, "2026-07-01", 0)).toEqual({
      date: "2026-07-01",
      durationDays: 1,
    });
  });

  test("rejects a non-finite day count", () => {
    const listing = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 1000 },
      duration_days: 5,
      listing_type: "daily",
    });
    expect(() => bookingDateFields(listing, "2026-07-01", Number.NaN)).toThrow(
      "Invalid booking duration: NaN",
    );
  });
});
