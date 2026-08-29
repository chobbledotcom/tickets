import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  childAddOnError,
  durationsCompatible,
  type EdgeListing,
  edgeFieldError,
  scopeIsChildDeadEnd,
  scopeReachesPage,
} from "#shared/listing-parents-rules.ts";

/** The i18n message a broken edge rule reports for the named listing — the
 * same key production formats, so tests assert WHICH rule won (and whose name
 * it blames) without re-typing the English copy. */
const ruleError = (messageKey: string, name: string): string =>
  t(`listings_table.children_err_${messageKey}`, { name });

describe("childAddOnError", () => {
  test("resolves to real copy naming the add-on and the child, not a raw key", () => {
    const message = childAddOnError("Face Paint", "Bouncy Castle");
    expect(message).toContain("Face Paint");
    expect(message).toContain("Bouncy Castle");
    expect(message).not.toContain("children_err");
  });
});

describe("scopeReachesPage", () => {
  test("a whole-order scope reaches every page", () => {
    expect(scopeReachesPage(null, new Set())).toBe(true);
  });

  test("a listing scope reaches a page that shares one of its ids", () => {
    expect(scopeReachesPage([7, 8], new Set([8, 9]))).toBe(true);
    expect(scopeReachesPage([7], new Set([8, 9]))).toBe(false);
  });
});

describe("scopeIsChildDeadEnd", () => {
  test("a whole-order add-on is never a dead end", () => {
    // A null scope means the add-on loads on every page, so no listing choice
    // takes it away.
    expect(scopeIsChildDeadEnd(null, new Set([5]), new Set())).toBe(false);
  });

  test("a scope that names no hidden child is never a dead end", () => {
    // Listing 5 keeps its own page. The add-on stays reachable there, whatever
    // the parent pages hold.
    expect(scopeIsChildDeadEnd([5], new Set([9]), new Set())).toBe(false);
  });

  test("a scope of one hidden child with no page left is a dead end", () => {
    expect(scopeIsChildDeadEnd([5], new Set([5]), new Set())).toBe(true);
  });

  test("one live page in the scope rescues the hidden child", () => {
    expect(scopeIsChildDeadEnd([5, 6], new Set([5]), new Set([6]))).toBe(false);
  });
});

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

  // One scenario per rule, each breaking only its own rule, paired with the
  // listing name its message must blame. Guards that every rule's message
  // resolves to real interpolated copy — a missing translation would make the
  // ruleError-based expectations below match the raw-key fallback on both
  // sides, so these assertions are what catch it.
  const blamedNameCases: [string, EdgeListing, EdgeListing, string][] = [
    [
      "parent renewal",
      listing({ months_per_unit: 1, name: "Membership" }),
      listing(),
      "Membership",
    ],
    [
      "child renewal",
      listing(),
      listing({ months_per_unit: 1, name: "Gold Tier" }),
      "Gold Tier",
    ],
    [
      "daily child under a non-daily parent",
      listing(),
      listing({ listing_type: "daily", name: "Cabin" }),
      "Cabin",
    ],
    [
      "duration mismatch",
      listing({ duration_days: 3, listing_type: "daily" }),
      listing({ duration_days: 5, listing_type: "daily", name: "Bell Tent" }),
      "Bell Tent",
    ],
  ];

  for (const [rule, parent, child, blamed] of blamedNameCases) {
    test(`the ${rule} error resolves to real copy naming '${blamed}', not a raw i18n key`, () => {
      const message = edgeFieldError(parent, child);
      expect(message).toContain(`'${blamed}'`);
      expect(message).not.toContain("children_err");
    });
  }

  test("the parent-renewal error when the parent is a renewal tier", () => {
    const parent = listing({ months_per_unit: 1, name: "Membership" });
    const child = listing({ name: "Child" });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("parent_renewal", "Membership"),
    );
  });

  test("the child-renewal error when the child is a renewal tier", () => {
    const parent = listing({ name: "Parent" });
    const child = listing({ months_per_unit: 1, name: "Membership" });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("child_renewal", "Membership"),
    );
  });

  test("the daily error when a daily child sits under a non-daily parent", () => {
    const parent = listing({ listing_type: "standard", name: "Parent" });
    const child = listing({ listing_type: "daily", name: "Cabin" });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("child_daily", "Cabin"),
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
      ruleError("child_duration", "Cabin"),
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
      ruleError("parent_renewal", "Parent"),
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
      ruleError("child_renewal", "Child"),
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
      ruleError("child_daily", "Cabin"),
    );
  });
});
