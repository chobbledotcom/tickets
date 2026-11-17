import { assert, assertStringIncludes } from "@std/assert";
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
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { edgeListing as listing } from "./listing-parents-rules/helpers.ts";

/** The i18n message a broken edge rule reports for the named listing — the
 * same key production formats, so tests assert WHICH rule won (and whose name
 * it blames) without re-typing the English copy. */
const ruleError = (messageKey: string, name: string): string =>
  t(`listings_table.children_err_${messageKey}`, { name });

/** The customisable child every duration-compatibility case pairs with. */
const cabin = (over: Partial<EdgeListing> = {}): EdgeListing =>
  listing({
    customisableDays: true,
    dayPrices: { 2: 200 },
    durationDays: 5,
    name: "Cabin",
    ...over,
  });

describe("childAddOnError", () => {
  test("resolves to real copy naming the add-on and the child, not a raw key", () => {
    const message = childAddOnError("Face Paint", "Bouncy Castle");
    expectIncludesAll(message, ["Face Paint", "Bouncy Castle"]);
    assert(!message.includes("children_err"));
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

describe("durationsCompatible", () => {
  describe("both customisable", () => {
    test("compatible when their day-count ranges overlap", () => {
      const parent = listing({
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
      });
      const child = listing({
        customisableDays: true,
        dayPrices: { 3: 300, 4: 400 },
        durationDays: 4,
      });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when their day-count ranges don't overlap", () => {
      const parent = listing({
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
      });
      const child = listing({
        customisableDays: true,
        dayPrices: { 5: 500 },
        durationDays: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  describe("customisable child, fixed (non-daily) parent", () => {
    test("compatible when the child prices the parent's fixed 1-day span", () => {
      const parent = listing({ listingType: "standard" });
      const child = listing({
        customisableDays: true,
        dayPrices: { 1: 100 },
        durationDays: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the child has no price for that span", () => {
      const parent = listing({ listingType: "standard" });
      const child = listing({
        customisableDays: true,
        dayPrices: { 2: 200 },
        durationDays: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  describe("customisable child, fixed daily parent", () => {
    test("compatible when the child prices the parent's own duration", () => {
      const parent = listing({
        durationDays: 4,
        listingType: "daily",
      });
      const child = listing({
        customisableDays: true,
        dayPrices: { 4: 400 },
        durationDays: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the child has no price for the parent's duration", () => {
      const parent = listing({
        durationDays: 4,
        listingType: "daily",
      });
      const child = listing({
        customisableDays: true,
        dayPrices: { 3: 300 },
        durationDays: 5,
      });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  test("a plain standard (non-daily, non-customisable) child fits under any parent", () => {
    const child = listing({
      customisableDays: false,
      listingType: "standard",
    });
    const dailyParent = listing({ durationDays: 10, listingType: "daily" });
    const customisableParent = listing({
      customisableDays: true,
      dayPrices: { 1: 100 },
      durationDays: 1,
    });
    expect(durationsCompatible(dailyParent, child)).toBe(true);
    expect(durationsCompatible(customisableParent, child)).toBe(true);
  });

  describe("fixed daily child, customisable parent", () => {
    test("compatible when the parent's range includes the child's duration", () => {
      const parent = listing({
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
      });
      const child = listing({ durationDays: 3, listingType: "daily" });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the parent's range excludes the child's duration", () => {
      const parent = listing({
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
      });
      const child = listing({ durationDays: 5, listingType: "daily" });
      expect(durationsCompatible(parent, child)).toBe(false);
    });
  });

  describe("fixed daily child, fixed parent", () => {
    test("compatible when the durations match exactly", () => {
      const parent = listing({ durationDays: 3, listingType: "daily" });
      const child = listing({ durationDays: 3, listingType: "daily" });
      expect(durationsCompatible(parent, child)).toBe(true);
    });

    test("incompatible when the durations differ", () => {
      const parent = listing({ durationDays: 3, listingType: "daily" });
      const child = listing({ durationDays: 4, listingType: "daily" });
      expect(durationsCompatible(parent, child)).toBe(false);
    });

    test("a non-daily parent's fixed duration is always 1, regardless of its own duration_days", () => {
      const parent = listing({ durationDays: 10, listingType: "standard" });
      const child = listing({ durationDays: 1, listingType: "daily" });
      expect(durationsCompatible(parent, child)).toBe(true);
      expect(durationsCompatible(parent, { ...child, durationDays: 2 })).toBe(
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
      listing({ monthsPerUnit: 1, name: "Membership" }),
      listing(),
      "Membership",
    ],
    [
      "child renewal",
      listing(),
      listing({ monthsPerUnit: 1, name: "Gold Tier" }),
      "Gold Tier",
    ],
    [
      "daily child under a non-daily parent",
      listing(),
      listing({ listingType: "daily", name: "Cabin" }),
      "Cabin",
    ],
    [
      "duration mismatch",
      listing({ durationDays: 3, listingType: "daily" }),
      listing({ durationDays: 5, listingType: "daily", name: "Bell Tent" }),
      "Bell Tent",
    ],
  ];

  for (const [rule, parent, child, blamed] of blamedNameCases) {
    test(`the ${rule} error resolves to real copy naming '${blamed}', not a raw i18n key`, () => {
      const message = edgeFieldError(parent, child);
      assertStringIncludes(message ?? "", `'${blamed}'`);
      assert(!(message ?? "").includes("children_err"));
    });
  }

  test("the parent-renewal error when the parent is a renewal tier", () => {
    const parent = listing({ monthsPerUnit: 1, name: "Membership" });
    const child = listing({ name: "Child" });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("parent_renewal", "Membership"),
    );
  });

  test("the child-renewal error when the child is a renewal tier", () => {
    const parent = listing({ name: "Parent" });
    const child = listing({ monthsPerUnit: 1, name: "Membership" });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("child_renewal", "Membership"),
    );
  });

  test("the daily error when a daily child sits under a non-daily parent", () => {
    const parent = listing({ listingType: "standard", name: "Parent" });
    const child = listing({ listingType: "daily", name: "Cabin" });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("child_daily", "Cabin"),
    );
  });

  test("a daily child under a daily parent passes the daily check", () => {
    const parent = listing({
      durationDays: 3,
      listingType: "daily",
      name: "Parent",
    });
    const child = listing({
      durationDays: 3,
      listingType: "daily",
      name: "Cabin",
    });
    expect(edgeFieldError(parent, child)).toBeNull();
  });

  // Each row pairs the clash (whose side varies: a fixed daily child, a fixed
  // daily parent versus a customisable child, a customisable parent) with the
  // two day-span descriptions the message must interpolate.
  const durationErrorCases: [
    string,
    EdgeListing,
    EdgeListing,
    string,
    string,
  ][] = [
    [
      "a daily child's duration differs from the parent's fixed span",
      listing({ durationDays: 3, listingType: "daily", name: "Parent" }),
      listing({ durationDays: 5, listingType: "daily", name: "Cabin" }),
      "3 days",
      "5 days",
    ],
    [
      "names the customisable parent's offered lengths",
      listing({
        customisableDays: true,
        dayPrices: { 2: 200, 3: 300 },
        durationDays: 3,
        name: "Festival",
      }),
      listing({
        customisableDays: true,
        dayPrices: { 5: 500 },
        durationDays: 5,
        name: "Cabin",
      }),
      "2 or 3 days",
      "5 days",
    ],
    [
      "names the customisable child's priced lengths",
      listing({ durationDays: 3, listingType: "daily", name: "Week" }),
      cabin(),
      "3 days",
      "2 days",
    ],
    [
      "names an unpriced customisable parent's empty offer",
      listing({
        customisableDays: true,
        dayPrices: {},
        durationDays: 3,
        name: "Empty",
      }),
      cabin(),
      "",
      "2 days",
    ],
    [
      "a fixed standard parent offers its single 1-day span",
      listing({ listingType: "standard", name: "Quick Stop" }),
      cabin(),
      "1 day",
      "2 days",
    ],
    [
      "sorts and counts the parent's offered lengths, including one day",
      listing({
        customisableDays: true,
        dayPrices: { 1: 100, 2: 200, 3: 300 },
        durationDays: 3,
        name: "Mixed",
      }),
      listing({
        customisableDays: true,
        dayPrices: { 5: 500 },
        durationDays: 5,
        name: "Cabin",
      }),
      "1, 2 or 3 days",
      "5 days",
    ],
  ];

  for (const [scenario, parent, child, offered, priced] of durationErrorCases) {
    test(`the duration error, ${scenario}`, () => {
      expect(edgeFieldError(parent, child)).toBe(
        t("listings_table.children_err_child_duration", {
          name: "Cabin",
          offered,
          priced,
        }),
      );
    });
  }

  test("the parent-renewal check wins over every other violation", () => {
    const parent = listing({ monthsPerUnit: 1, name: "Parent" });
    const child = listing({
      listingType: "daily",
      monthsPerUnit: 1,
      name: "Child",
    });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("parent_renewal", "Parent"),
    );
  });

  test("the child-renewal check wins over the daily and duration checks", () => {
    const parent = listing({ listingType: "standard", name: "Parent" });
    const child = listing({
      listingType: "daily",
      monthsPerUnit: 1,
      name: "Child",
    });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("child_renewal", "Child"),
    );
  });

  test("the daily check wins over the duration check", () => {
    // Also incompatible on duration (5 vs the non-daily parent's fixed 1),
    // but the daily mismatch is checked first.
    const parent = listing({ listingType: "standard", name: "Parent" });
    const child = listing({
      durationDays: 5,
      listingType: "daily",
      name: "Cabin",
    });
    expect(edgeFieldError(parent, child)).toBe(
      ruleError("child_daily", "Cabin"),
    );
  });

  /** The child that prices only day 2 — a customisable parent's selectable
   *  counts that miss it, a fixed daily parent whose span misses it, and an
   *  empty customisable parent — all refuse with the same priced side. */
  const underpricingParent: EdgeListing = listing({
    customisableDays: true,
    dayPrices: { 2: 2000 },
    durationDays: 2,
    name: "Cabin",
  });

  const durationRefusal = (child: EdgeListing, offered: string): string =>
    t("listings_table.children_err_child_duration", {
      name: child.name,
      offered,
      priced: "2 days",
    });

  for (const [description, parent, offered] of [
    [
      "names the parent's offered lengths sorted, joined by 'or'",
      listing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000, 7: 7000 },
        durationDays: 7,
        name: "Parent",
      }),
      "1, 3 or 7 days",
    ],
    [
      "a fixed daily parent offers its one resolved span",
      listing({ durationDays: 6, listingType: "daily", name: "Parent" }),
      "6 days",
    ],
    [
      "a customisable parent pricing no counts offers nothing",
      listing({ customisableDays: true, dayPrices: {}, name: "Parent" }),
      "",
    ],
  ] as const) {
    test(description, () => {
      expect(edgeFieldError(parent, underpricingParent)).toBe(
        durationRefusal(underpricingParent, offered),
      );
    });
  }
});
