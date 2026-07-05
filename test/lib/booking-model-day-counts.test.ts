import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  childDaysFromParent,
  dayCountsChildSupports,
  dayCountsEveryListingSupports,
  encodeChildDatesByDayCount,
  fixedParentDays,
  keepDayCountsChildrenSupport,
  keepOptionsSomeChildSupports,
  keepParentDayCountsChildrenSupport,
  packageDayCountsChildrenSupport,
  type TicketListing,
  updateForMembersWithChildren,
} from "#shared/booking/model.ts";
import { useSetting } from "#test-utils";
import {
  oneChildSupportingDayTwo,
  resolved,
} from "./booking-model-fixtures.ts";

describe("booking model — day-count support", () => {
  useSetting({ timezone: "UTC" });

  describe("encodeChildDatesByDayCount", () => {
    test("encodes one day count with its dates", () => {
      const map = new Map([[3, ["2026-01-01", "2026-01-02"]]]);
      expect(encodeChildDatesByDayCount(map)).toBe("3:2026-01-01,2026-01-02");
    });

    test("joins multiple day counts with a pipe, preserving insertion order", () => {
      const map = new Map([
        [5, ["2026-02-01"]],
        [2, ["2026-01-01", "2026-01-15"]],
      ]);
      expect(encodeChildDatesByDayCount(map)).toBe(
        "5:2026-02-01|2:2026-01-01,2026-01-15",
      );
    });

    test("encodes an empty map as an empty string", () => {
      expect(encodeChildDatesByDayCount(new Map())).toBe("");
    });

    test("encodes a day count with no dates with an empty date list", () => {
      expect(encodeChildDatesByDayCount(new Map([[4, []]]))).toBe("4:");
    });
  });

  describe("childDaysFromParent", () => {
    test("uses the customisable value when the buyer chooses the day count", () => {
      const parent = {
        customisable_days: true,
        duration_days: 5,
        listing_type: "standard" as const,
      };
      expect(childDaysFromParent(parent, 1, 2)).toBe(1);
    });

    test("uses the parent's fixed duration for a daily parent", () => {
      const parent = {
        customisable_days: false,
        duration_days: 5,
        listing_type: "daily" as const,
      };
      expect(childDaysFromParent<number | null>(parent, null, 99)).toBe(5);
    });

    test("uses the standard value for a non-daily, non-customisable parent", () => {
      const parent = {
        customisable_days: false,
        duration_days: 5,
        listing_type: "standard" as const,
      };
      expect(childDaysFromParent(parent, 1, 2)).toBe(2);
    });
  });

  describe("fixedParentDays", () => {
    test("null when the buyer chooses the day count", () => {
      expect(
        fixedParentDays({
          customisable_days: true,
          duration_days: 5,
          listing_type: "standard",
        }),
      ).toBeNull();
    });

    test("the normalized duration for a daily parent", () => {
      expect(
        fixedParentDays({
          customisable_days: false,
          duration_days: 5,
          listing_type: "daily",
        }),
      ).toBe(5);
    });

    test("the normalized (clamped) duration for a standard parent", () => {
      expect(
        fixedParentDays({
          customisable_days: false,
          duration_days: 200,
          listing_type: "standard",
        }),
      ).toBe(90);
    });
  });

  describe("keepOptionsSomeChildSupports", () => {
    test("keeps only options at least one usable child supports", () => {
      const children = [resolved({ id: 1 }), resolved({ id: 2 })];
      const canUse = (child: TicketListing) => child.listing.id === 1;
      const optionsFor = (child: TicketListing) =>
        child.listing.id === 1 ? [1, 2] : [3, 4];
      expect(
        keepOptionsSomeChildSupports(
          [1, 2, 3, 4],
          children,
          canUse,
          optionsFor,
        ),
      ).toEqual([1, 2]);
    });

    test("empty when no children are usable", () => {
      const children = [resolved({ id: 1 })];
      expect(
        keepOptionsSomeChildSupports(
          [1, 2],
          children,
          () => false,
          () => [1, 2],
        ),
      ).toEqual([]);
    });

    test("preserves the original options order, not the discovery order", () => {
      const children = [resolved({ id: 1 })];
      expect(
        keepOptionsSomeChildSupports(
          [3, 1, 2],
          children,
          () => true,
          () => [1, 2, 3],
        ),
      ).toEqual([3, 1, 2]);
    });
  });

  describe("updateForMembersWithChildren", () => {
    for (const [label, childrenByParentId] of [
      ["has no children entry", new Map<number, TicketListing[]>()],
      ["has an empty children array", new Map([[1, []]])],
    ] as const) {
      test(`skips the step for a member that ${label}`, () => {
        const result = updateForMembersWithChildren(
          [resolved({ id: 1 })],
          childrenByParentId,
          0,
          (acc) => acc + 1,
        );
        expect(result).toBe(0);
      });
    }

    test("carries the accumulator through each member with children", () => {
      const members = [resolved({ id: 1 }), resolved({ id: 2 })];
      const childrenByParentId = new Map([
        [1, [resolved({ id: 10 })]],
        [2, [resolved({ id: 11 })]],
      ]);
      const result = updateForMembersWithChildren(
        members,
        childrenByParentId,
        [] as number[],
        (acc, member) => [...acc, member.listing.id],
      );
      expect(result).toEqual([1, 2]);
    });
  });

  describe("dayCountsEveryListingSupports", () => {
    test("empty when there are no customisable listings", () => {
      const listings = [resolved({ customisable_days: false })];
      expect(dayCountsEveryListingSupports(listings)).toEqual([]);
    });

    test("intersects day counts across every customisable listing, sorted ascending", () => {
      const listings = [
        resolved({
          customisable_days: true,
          day_prices: { 1: 100, 2: 200, 3: 300 },
          duration_days: 3,
        }),
        resolved({
          customisable_days: true,
          day_prices: { 2: 250, 3: 350 },
          duration_days: 3,
        }),
      ];
      expect(dayCountsEveryListingSupports(listings)).toEqual([2, 3]);
    });

    test("ignores non-customisable listings when intersecting", () => {
      const listings = [
        resolved({
          customisable_days: true,
          day_prices: { 1: 100, 2: 200 },
          duration_days: 2,
        }),
        resolved({ customisable_days: false }),
      ];
      expect(dayCountsEveryListingSupports(listings)).toEqual([1, 2]);
    });
  });

  describe("dayCountsChildSupports", () => {
    test("customisable child returns its available day counts", () => {
      const child = resolved({
        customisable_days: true,
        day_prices: { 1: 100, 3: 300 },
        duration_days: 3,
      });
      expect(dayCountsChildSupports(child)).toEqual([1, 3]);
    });

    test("fixed daily child returns only its own duration", () => {
      const child = resolved({
        customisable_days: false,
        duration_days: 4,
        listing_type: "daily",
      });
      expect(dayCountsChildSupports(child)).toEqual([4]);
    });

    test("non-daily fixed child supports any day count", () => {
      const child = resolved({
        customisable_days: false,
        listing_type: "standard",
      });
      expect(dayCountsChildSupports(child)).toBeNull();
    });
  });

  describe("keepDayCountsChildrenSupport", () => {
    test("keeps counts every member's children collectively support", () => {
      const parent1 = resolved({ id: 1 });
      const parent2 = resolved({ id: 2 });
      const childrenByParentId = new Map([
        [
          1,
          [
            resolved({
              customisable_days: true,
              day_prices: { 2: 200, 3: 300 },
              duration_days: 3,
              id: 10,
            }),
          ],
        ],
        [
          2,
          [
            resolved({
              customisable_days: true,
              day_prices: { 3: 300 },
              duration_days: 3,
              id: 11,
            }),
          ],
        ],
      ]);
      expect(
        keepDayCountsChildrenSupport(
          [parent1, parent2],
          [2, 3],
          childrenByParentId,
        ),
      ).toEqual([3]);
    });

    test("members without a children entry don't restrict the counts", () => {
      const parent1 = resolved({ id: 1 });
      expect(
        keepDayCountsChildrenSupport([parent1], [2, 3], new Map()),
      ).toEqual([2, 3]);
    });

    test("only bookable children are considered", () => {
      const parent = resolved({ id: 1 });
      const childrenByParentId = new Map([
        [
          1,
          [
            resolved({
              active: false,
              customisable_days: true,
              day_prices: { 2: 200 },
              duration_days: 2,
              id: 10,
            }),
          ],
        ],
      ]);
      expect(
        keepDayCountsChildrenSupport([parent], [2], childrenByParentId),
      ).toEqual([]);
    });
  });

  describe("keepParentDayCountsChildrenSupport", () => {
    test("returns the parent day counts unchanged when there's no children map", () => {
      const listings = [resolved({ id: 1 })];
      expect(
        keepParentDayCountsChildrenSupport(listings, [2, 3], undefined),
      ).toEqual([2, 3]);
    });

    test("returns the parent day counts unchanged for a multi-listing package", () => {
      const listings = [resolved({ id: 1 }), resolved({ id: 2 })];
      const childrenByParentId = new Map([[1, []]]);
      expect(
        keepParentDayCountsChildrenSupport(
          listings,
          [2, 3],
          childrenByParentId,
        ),
      ).toEqual([2, 3]);
    });

    test("ignores children entirely for a multi-listing package, even a restrictive one", () => {
      const listings = [resolved({ id: 1 }), resolved({ id: 2 })];
      expect(
        keepParentDayCountsChildrenSupport(
          listings,
          [2, 3],
          oneChildSupportingDayTwo(),
        ),
      ).toEqual([2, 3]);
    });

    test("restricts to what children support for a single-listing selection", () => {
      const listing1 = resolved({ id: 1 });
      expect(
        keepParentDayCountsChildrenSupport(
          [listing1],
          [2, 3],
          oneChildSupportingDayTwo(),
        ),
      ).toEqual([2]);
    });
  });

  describe("packageDayCountsChildrenSupport", () => {
    test("combines every listing's own supported counts with what children can support", () => {
      const listing1 = resolved({
        customisable_days: true,
        day_prices: { 2: 200, 3: 300 },
        duration_days: 3,
        id: 1,
      });
      expect(
        packageDayCountsChildrenSupport([listing1], oneChildSupportingDayTwo()),
      ).toEqual([2]);
    });

    test("empty when no listing is customisable", () => {
      const listing1 = resolved({ customisable_days: false, id: 1 });
      expect(packageDayCountsChildrenSupport([listing1], new Map())).toEqual(
        [],
      );
    });
  });
});
