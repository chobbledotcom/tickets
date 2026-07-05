import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookableChildIds,
  buildTicketListing,
  childActive,
  childCanBePickedBeforeDays,
  childDateKey,
  childDateOk,
  childDaysFromParent,
  childHasDateOrStockForDays,
  childHasPriceForDays,
  childInStock,
  childOpen,
  childPassesAllChecks,
  childUsesSameDays,
  dayCountsChildSupports,
  dayCountsEveryListingSupports,
  encodeChildDatesByDayCount,
  fixedParentDays,
  keepDayCountsChildrenSupport,
  keepOptionsSomeChildSupports,
  keepParentDayCountsChildrenSupport,
  packageDayCountsChildrenSupport,
  parentAndChildFitGroup,
  type TicketListing,
  ticketsThatFitInPool,
  updateForMembersWithChildren,
} from "#shared/booking/model.ts";
import { DAY_NAMES } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { VALID_DAY_NAMES } from "#templates/fields.ts";
import { testListingWithCount, useSetting } from "#test-utils";

const today = () => todayInTz("UTC");
const weekdayOf = (dateStr: string) =>
  DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]!;

const listing = (over: Partial<ListingWithCount> = {}): ListingWithCount =>
  testListingWithCount({ id: 1, ...over });

const resolved = (
  over: Partial<ListingWithCount> = {},
  closed = false,
  groupRemaining?: number,
): TicketListing => buildTicketListing(listing(over), closed, groupRemaining);

const dailyOverrides = (
  over: Partial<ListingWithCount> = {},
): Partial<ListingWithCount> => ({
  bookable_days: [...VALID_DAY_NAMES],
  listing_type: "daily",
  maximum_days_after: 10,
  minimum_days_before: 0,
  ...over,
});

/** One customisable child under parent id 1, supporting only a 2-day booking. */
const oneChildSupportingDayTwo = (): ReadonlyMap<number, TicketListing[]> =>
  new Map([
    [
      1,
      [
        resolved({
          customisable_days: true,
          day_prices: { 2: 200 },
          duration_days: 2,
          id: 10,
        }),
      ],
    ],
  ]);

describe("booking model", () => {
  useSetting({ timezone: "UTC" });

  describe("childDateKey", () => {
    test("joins parent and child ids with a colon", () => {
      expect(childDateKey(3, 7)).toBe("3:7");
    });

    test("order matters — parent then child", () => {
      expect(childDateKey(7, 3)).toBe("7:3");
      expect(childDateKey(7, 3)).not.toBe(childDateKey(3, 7));
    });
  });

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

  describe("childActive", () => {
    test("true when the listing is active", () => {
      expect(childActive(resolved({ active: true }))).toBe(true);
    });

    test("false when the listing is inactive", () => {
      expect(childActive(resolved({ active: false }))).toBe(false);
    });
  });

  describe("childOpen", () => {
    test("true when not closed", () => {
      expect(childOpen(resolved({}, false))).toBe(true);
    });

    test("false when closed", () => {
      expect(childOpen(resolved({}, true))).toBe(false);
    });
  });

  describe("childInStock", () => {
    test("true when spots remain", () => {
      expect(
        childInStock(resolved({ attendee_count: 0, max_attendees: 10 })),
      ).toBe(true);
    });

    test("false when sold out", () => {
      expect(
        childInStock(resolved({ attendee_count: 5, max_attendees: 5 })),
      ).toBe(false);
    });
  });

  describe("childHasDateOrStockForDays", () => {
    test("standard listings fall back to the stock check, ignoring dates", () => {
      const check = childHasDateOrStockForDays([], 3, null);
      expect(
        check(
          resolved({
            attendee_count: 1,
            listing_type: "standard",
            max_attendees: 1,
          }),
        ),
      ).toBe(false);
      expect(
        check(
          resolved({
            attendee_count: 0,
            listing_type: "standard",
            max_attendees: 1,
          }),
        ),
      ).toBe(true);
    });

    test("daily listing with no bookable weekday has no date", () => {
      const check = childHasDateOrStockForDays([], 3, null);
      expect(check(resolved(dailyOverrides({ bookable_days: [] })))).toBe(
        false,
      );
    });

    test("daily listing with every weekday bookable has a date within the window", () => {
      const check = childHasDateOrStockForDays([], 3, null);
      expect(check(resolved(dailyOverrides()))).toBe(true);
    });

    test("restricts to the parent's own dates when given", () => {
      const check = childHasDateOrStockForDays([], 3, new Set());
      expect(check(resolved(dailyOverrides()))).toBe(false);
    });

    test("allows a date that is included in the parent's own dates", () => {
      const check = childHasDateOrStockForDays([], 3, new Set([today()]));
      expect(check(resolved(dailyOverrides()))).toBe(true);
    });

    describe("day count precision", () => {
      // Only one weekday a week is bookable, so a 1-day booking always fits
      // but any 2-day-or-longer span never does — this distinguishes an
      // explicit day count from the `days ?? 1` fallback, and distinguishes
      // that fallback's `1` from a nearby wrong constant.
      const singleWeekdayChild = () =>
        resolved(
          dailyOverrides({
            bookable_days: [weekdayOf(today())],
            maximum_days_after: 30,
          }),
        );

      test("defaults an absent day count to exactly 1", () => {
        const child = singleWeekdayChild();
        expect(childHasDateOrStockForDays([], null, null)(child)).toBe(true);
        expect(childHasDateOrStockForDays([], 1, null)(child)).toBe(true);
      });

      test("keeps an explicit day count exact, however small", () => {
        const child = singleWeekdayChild();
        expect(childHasDateOrStockForDays([], 2, null)(child)).toBe(false);
        expect(childHasDateOrStockForDays([], 3, null)(child)).toBe(false);
      });
    });
  });

  describe("childHasPriceForDays", () => {
    test("non-customisable listings always have a price", () => {
      const check = childHasPriceForDays(5);
      expect(check(resolved({ customisable_days: false }))).toBe(true);
    });

    test("customisable listing with a price for the day count", () => {
      const check = childHasPriceForDays(3);
      const child = resolved({
        customisable_days: true,
        day_prices: { 3: 500 },
        duration_days: 5,
      });
      expect(check(child)).toBe(true);
    });

    test("customisable listing missing a price for the day count", () => {
      const check = childHasPriceForDays(3);
      const child = resolved({
        customisable_days: true,
        day_prices: { 4: 500 },
        duration_days: 5,
      });
      expect(check(child)).toBe(false);
    });
  });

  describe("childUsesSameDays", () => {
    test("customisable-day children always match", () => {
      const check = childUsesSameDays(3);
      expect(
        check(
          resolved({
            customisable_days: true,
            duration_days: 7,
            listing_type: "daily",
          }),
        ),
      ).toBe(true);
    });

    test("non-daily children always match regardless of duration", () => {
      const check = childUsesSameDays(3);
      expect(
        check(
          resolved({
            customisable_days: false,
            duration_days: 99,
            listing_type: "standard",
          }),
        ),
      ).toBe(true);
    });

    test("fixed daily child matches only its own duration", () => {
      const check = childUsesSameDays(3);
      expect(
        check(
          resolved({
            customisable_days: false,
            duration_days: 3,
            listing_type: "daily",
          }),
        ),
      ).toBe(true);
      expect(
        check(
          resolved({
            customisable_days: false,
            duration_days: 4,
            listing_type: "daily",
          }),
        ),
      ).toBe(false);
    });
  });

  describe("childDateOk", () => {
    test("non-daily children are always ok, even with no date", () => {
      const check = childDateOk(null, [], 3);
      expect(check(resolved({ listing_type: "standard" }))).toBe(true);
    });

    test("daily children need a date", () => {
      const check = childDateOk(null, [], 3);
      expect(check(resolved(dailyOverrides()))).toBe(false);
    });

    test("customisable-days daily child validates the chosen range", () => {
      const check = childDateOk(today(), [], 3);
      expect(
        check(
          resolved(
            dailyOverrides({ customisable_days: true, duration_days: 10 }),
          ),
        ),
      ).toBe(true);
      expect(
        check(
          resolved(
            dailyOverrides({
              bookable_days: [],
              customisable_days: true,
              duration_days: 10,
            }),
          ),
        ),
      ).toBe(false);
    });

    test("fixed daily child checks the date is an offered start date", () => {
      const check = childDateOk(today(), [], 3);
      expect(check(resolved(dailyOverrides()))).toBe(true);
      expect(check(resolved(dailyOverrides({ bookable_days: [] })))).toBe(
        false,
      );
    });

    test("fixed daily child uses its own start-date list, not the requested duration", () => {
      // duration_days stays at the factory default of 1, but the requested
      // duration here is 5 — a fixed (non-customisable) child must go through
      // getBookableStartDates().includes(date), not isBookingRangeValid with
      // the caller's duration, so a mismatched requested duration doesn't
      // affect a fixed child's own single-day start-date list.
      const date = today();
      const check = childDateOk(date, [], 5);
      expect(
        check(resolved(dailyOverrides({ bookable_days: [weekdayOf(date)] }))),
      ).toBe(true);
    });
  });

  describe("parentAndChildFitGroup", () => {
    test("fits when both cap and remaining are undefined (uncapped)", () => {
      expect(
        parentAndChildFitGroup({ remaining: undefined, staticCap: undefined }),
      ).toBe(true);
    });

    test("fits exactly at the parent+child unit count", () => {
      expect(
        parentAndChildFitGroup({ remaining: undefined, staticCap: 2 }),
      ).toBe(true);
      expect(
        parentAndChildFitGroup({ remaining: 2, staticCap: undefined }),
      ).toBe(true);
    });

    test("does not fit one below the parent+child unit count", () => {
      expect(
        parentAndChildFitGroup({ remaining: undefined, staticCap: 1 }),
      ).toBe(false);
      expect(
        parentAndChildFitGroup({ remaining: 1, staticCap: undefined }),
      ).toBe(false);
    });

    test("both constraints must pass", () => {
      expect(parentAndChildFitGroup({ remaining: 1, staticCap: 5 })).toBe(
        false,
      );
      expect(parentAndChildFitGroup({ remaining: 5, staticCap: 1 })).toBe(
        false,
      );
    });
  });

  describe("ticketsThatFitInPool", () => {
    test("divides remaining spots evenly", () => {
      expect(ticketsThatFitInPool(10, 2)).toBe(5);
    });

    test("rounds down when it doesn't divide evenly", () => {
      expect(ticketsThatFitInPool(7, 2)).toBe(3);
    });

    test("returns zero when nothing fits", () => {
      expect(ticketsThatFitInPool(1, 2)).toBe(0);
    });
  });

  describe("childPassesAllChecks", () => {
    test("true only when every check passes", () => {
      const allTrue = childPassesAllChecks([() => true, () => true]);
      const oneFalse = childPassesAllChecks([() => true, () => false]);
      const child = resolved();
      expect(allTrue(child)).toBe(true);
      expect(oneFalse(child)).toBe(false);
    });

    test("passes vacuously with no checks", () => {
      expect(childPassesAllChecks([])(resolved())).toBe(true);
    });
  });

  describe("childCanBePickedBeforeDays", () => {
    test("true for an active, open, in-stock child", () => {
      expect(
        childCanBePickedBeforeDays(
          resolved({ active: true, attendee_count: 0, max_attendees: 10 }),
        ),
      ).toBe(true);
    });

    test("false when inactive", () => {
      expect(childCanBePickedBeforeDays(resolved({ active: false }))).toBe(
        false,
      );
    });

    test("false when closed", () => {
      expect(childCanBePickedBeforeDays(resolved({}, true))).toBe(false);
    });

    test("false when sold out", () => {
      expect(
        childCanBePickedBeforeDays(
          resolved({ attendee_count: 1, max_attendees: 1 }),
        ),
      ).toBe(false);
    });
  });

  describe("bookableChildIds", () => {
    test("collects ids of every bookable child across all parents", () => {
      const map = new Map([
        [1, [resolved({ active: true, id: 10 })]],
        [
          2,
          [
            resolved({ active: false, id: 11 }),
            resolved({ active: true, id: 12 }),
          ],
        ],
      ]);
      expect(bookableChildIds(map)).toEqual(new Set([10, 12]));
    });

    test("empty set for undefined input", () => {
      expect(bookableChildIds(undefined)).toEqual(new Set());
    });

    test("empty set when no children are bookable", () => {
      const map = new Map([[1, [resolved({ active: false })]]]);
      expect(bookableChildIds(map)).toEqual(new Set());
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

  describe("buildTicketListing", () => {
    test("standard listing capacity is max_attendees minus attendee_count", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 3,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 100,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(7);
    });

    test("daily listings have unlimited seat capacity of their own", () => {
      const tl = buildTicketListing(
        listing({ listing_type: "daily", max_quantity: 5 }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(5);
    });

    test("daily listings ignore attendee headcount entirely, even at a full house", () => {
      // max_attendees/attendee_count would say sold out for a standard
      // listing, but a daily listing's own capacity is unlimited (each day
      // is its own booking) — max_quantity is the only real cap here.
      const tl = buildTicketListing(
        listing({
          attendee_count: 5,
          listing_type: "daily",
          max_attendees: 5,
          max_quantity: 100,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(100);
    });

    test("sold out when remaining spots are zero", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 10,
          listing_type: "standard",
          max_attendees: 10,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(true);
      expect(tl.maxPurchasable).toBe(0);
    });

    test("group cap takes the minimum of the listing's own remaining and the shared group's remaining", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 0,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 10,
        }),
        false,
        3,
      );
      expect(tl.maxPurchasable).toBe(3);
    });

    test("closed listings have zero purchasable even with stock", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 0,
          listing_type: "standard",
          max_attendees: 10,
        }),
        true,
        undefined,
      );
      expect(tl.isClosed).toBe(true);
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(0);
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
