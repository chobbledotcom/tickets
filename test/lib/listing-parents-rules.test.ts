import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  durationsCompatible,
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";

const listing = (over: Partial<EdgeListing> = {}): EdgeListing => ({
  customisable_days: false,
  day_prices: {},
  duration_days: 1,
  id: 1,
  listing_type: "standard",
  months_per_unit: 0,
  name: "Test",
  ...over,
});

describe("durationsCompatible", () => {
  describe("both customisable", () => {
    test("compatible when their day-count ranges overlap", () => {
      const parent = listing({
        customisable_days: true,
        day_prices: { 2: 200, 3: 300 },
        duration_days: 3,
      });
      const child = listing({
        customisable_days: true,
        day_prices: { 3: 300, 4: 400 },
        duration_days: 4,
      });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when their day-count ranges don't overlap", () => {
      const parent = listing({
        customisable_days: true,
        day_prices: { 2: 200, 3: 300 },
        duration_days: 3,
      });
      const child = listing({
        customisable_days: true,
        day_prices: { 5: 500 },
        duration_days: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  describe("customisable child, fixed (non-daily) parent", () => {
    test("compatible when the child prices the parent's fixed 1-day span", () => {
      const parent = listing({ listing_type: "standard" });
      const child = listing({
        customisable_days: true,
        day_prices: { 1: 100 },
        duration_days: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the child has no price for that span", () => {
      const parent = listing({ listing_type: "standard" });
      const child = listing({
        customisable_days: true,
        day_prices: { 2: 200 },
        duration_days: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  describe("customisable child, fixed daily parent", () => {
    test("compatible when the child prices the parent's own duration", () => {
      const parent = listing({
        duration_days: 4,
        listing_type: "daily",
      });
      const child = listing({
        customisable_days: true,
        day_prices: { 4: 400 },
        duration_days: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the child has no price for the parent's duration", () => {
      const parent = listing({
        duration_days: 4,
        listing_type: "daily",
      });
      const child = listing({
        customisable_days: true,
        day_prices: { 3: 300 },
        duration_days: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  test("a plain standard (non-daily, non-customisable) child fits under any parent", () => {
    const child = listing({
      customisable_days: false,
      listing_type: "standard",
    });
    const dailyParent = listing({ duration_days: 10, listing_type: "daily" });
    const customisableParent = listing({
      customisable_days: true,
      day_prices: { 1: 100 },
      duration_days: 1,
    });
    expect(durationsCompatible(dailyParent, child)).toBe(true);
    expect(durationsCompatible(customisableParent, child)).toBe(true);
  });

  describe("fixed daily child, customisable parent", () => {
    test("compatible when the parent's range includes the child's duration", () => {
      const parent = listing({
        customisable_days: true,
        day_prices: { 2: 200, 3: 300 },
        duration_days: 3,
      });
      const child = listing({ duration_days: 3, listing_type: "daily" });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the parent's range excludes the child's duration", () => {
      const parent = listing({
        customisable_days: true,
        day_prices: { 2: 200, 3: 300 },
        duration_days: 3,
      });
      const child = listing({ duration_days: 5, listing_type: "daily" });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  describe("fixed daily child, fixed parent", () => {
    test("compatible when the durations match exactly", () => {
      const parent = listing({ duration_days: 3, listing_type: "daily" });
      const child = listing({ duration_days: 3, listing_type: "daily" });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the durations differ", () => {
      const parent = listing({ duration_days: 3, listing_type: "daily" });
      const child = listing({ duration_days: 4, listing_type: "daily" });
      expect(durationsCompatible(parent, child)).toBe(false);
    });

    test("a non-daily parent's fixed duration is always 1, regardless of its own duration_days", () => {
      const parent = listing({ duration_days: 10, listing_type: "standard" });
      const child = listing({ duration_days: 1, listing_type: "daily" });
      expect(durationsCompatible(parent, child)).toBe(true);
      expect(durationsCompatible(parent, { ...child, duration_days: 2 })).toBe(
        false,
      );
    });
  });
});

describe("edgeFieldError", () => {
  test("null when the edge is fully compatible", () => {
    const parent = listing({ name: "Parent" });
    const child = listing({ name: "Child" });
    expect(edgeFieldError(parent, child)).toBeNull();
  });

  test("the parent-renewal error when the parent is a renewal tier", () => {
    const parent = listing({ months_per_unit: 1, name: "Membership" });
    const child = listing({ name: "Child" });
    expect(edgeFieldError(parent, child)).toBe(
      "'Membership' is a renewal tier, so it can't require child listings.",
    );
  });

  test("the child-renewal error when the child is a renewal tier", () => {
    const parent = listing({ name: "Parent" });
    const child = listing({ months_per_unit: 1, name: "Membership" });
    expect(edgeFieldError(parent, child)).toBe(
      "'Membership' is a renewal tier, so it can't be a child listing.",
    );
  });

  test("the daily error when a daily child sits under a non-daily parent", () => {
    const parent = listing({ listing_type: "standard", name: "Parent" });
    const child = listing({ listing_type: "daily", name: "Cabin" });
    expect(edgeFieldError(parent, child)).toBe(
      "'Cabin' is a daily listing, so it can only be a child of another daily listing.",
    );
  });

  test("a daily child under a daily parent passes the daily check", () => {
    const parent = listing({
      duration_days: 3,
      listing_type: "daily",
      name: "Parent",
    });
    const child = listing({
      duration_days: 3,
      listing_type: "daily",
      name: "Cabin",
    });
    expect(edgeFieldError(parent, child)).toBeNull();
  });

  test("the duration error when the durations are incompatible", () => {
    const parent = listing({
      duration_days: 3,
      listing_type: "daily",
      name: "Parent",
    });
    const child = listing({
      duration_days: 5,
      listing_type: "daily",
      name: "Cabin",
    });
    expect(edgeFieldError(parent, child)).toBe(
      "'Cabin' can't be booked for the same length as its parent — adjust its duration or day prices to match.",
    );
  });

  test("the parent-renewal check wins over every other violation", () => {
    const parent = listing({ months_per_unit: 1, name: "Parent" });
    const child = listing({
      listing_type: "daily",
      months_per_unit: 1,
      name: "Child",
    });
    expect(edgeFieldError(parent, child)).toBe(
      "'Parent' is a renewal tier, so it can't require child listings.",
    );
  });

  test("the child-renewal check wins over the daily and duration checks", () => {
    const parent = listing({ listing_type: "standard", name: "Parent" });
    const child = listing({
      listing_type: "daily",
      months_per_unit: 1,
      name: "Child",
    });
    expect(edgeFieldError(parent, child)).toBe(
      "'Child' is a renewal tier, so it can't be a child listing.",
    );
  });

  test("the daily check wins over the duration check", () => {
    // Also incompatible on duration (5 vs the non-daily parent's fixed 1),
    // but the daily mismatch is checked first.
    const parent = listing({ listing_type: "standard", name: "Parent" });
    const child = listing({
      duration_days: 5,
      listing_type: "daily",
      name: "Cabin",
    });
    expect(edgeFieldError(parent, child)).toBe(
      "'Cabin' is a daily listing, so it can only be a child of another daily listing.",
    );
  });
});
