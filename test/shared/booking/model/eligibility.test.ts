import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookableChildIds,
  childActive,
  childCanBeBooked,
  childDateOk,
  childHasDateOrStockForDays,
  childInStock,
  childOpen,
  childPassesAllChecks,
  childSupportsDays,
} from "#booking/model.ts";
import {
  dailyOverrides,
  resolved,
  today,
  weekdayOf,
} from "#test-utils/booking-model-fixtures.ts";
import { useSetting } from "#test-utils/settings.ts";

describe("booking model — child eligibility", () => {
  useSetting({ timezone: "UTC" });

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
        childInStock(resolved({ attendeeCount: 0, maxAttendees: 10 })),
      ).toBe(true);
    });

    test("false when sold out", () => {
      expect(
        childInStock(resolved({ attendeeCount: 5, maxAttendees: 5 })),
      ).toBe(false);
    });
  });

  describe("childHasDateOrStockForDays", () => {
    test("standard listings fall back to the stock check, ignoring dates", () => {
      const check = childHasDateOrStockForDays([], 3, null);
      expect(
        check(
          resolved({
            attendeeCount: 1,
            listingType: "standard",
            maxAttendees: 1,
          }),
        ),
      ).toBe(false);
      expect(
        check(
          resolved({
            attendeeCount: 0,
            listingType: "standard",
            maxAttendees: 1,
          }),
        ),
      ).toBe(true);
    });

    test("daily listing with no bookable weekday has no date", () => {
      const check = childHasDateOrStockForDays([], 3, null);
      expect(check(resolved(dailyOverrides({ bookableDays: [] })))).toBe(false);
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
            bookableDays: [weekdayOf(today())],
            maximumDaysAfter: 30,
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

  describe("childSupportsDays", () => {
    test("a standard child serves any span", () => {
      expect(childSupportsDays(resolved({ customisableDays: false }), 5)).toBe(
        true,
      );
    });

    test("a customisable child serves only a count it prices", () => {
      const child = resolved({
        customisableDays: true,
        dayPrices: { 3: 500 },
        durationDays: 5,
      });
      expect(childSupportsDays(child, 3)).toBe(true);
      expect(childSupportsDays(child, 4)).toBe(false);
    });

    test("a customisable child with no offered count serves nothing", () => {
      const child = resolved({
        customisableDays: true,
        dayPrices: {},
        durationDays: 5,
      });
      expect(childSupportsDays(child, 1)).toBe(false);
    });

    test("a fixed daily child serves only its own duration", () => {
      const child = resolved({
        customisableDays: false,
        durationDays: 3,
        listingType: "daily",
      });
      expect(childSupportsDays(child, 3)).toBe(true);
      expect(childSupportsDays(child, 4)).toBe(false);
    });
  });

  describe("childDateOk", () => {
    test("non-daily children are always ok, even with no date", () => {
      const check = childDateOk(null, [], 3);
      expect(check(resolved({ listingType: "standard" }))).toBe(true);
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
            dailyOverrides({ customisableDays: true, durationDays: 10 }),
          ),
        ),
      ).toBe(true);
      expect(
        check(
          resolved(
            dailyOverrides({
              bookableDays: [],
              customisableDays: true,
              durationDays: 10,
            }),
          ),
        ),
      ).toBe(false);
    });

    test("fixed daily child checks the date is an offered start date", () => {
      const check = childDateOk(today(), [], 3);
      expect(check(resolved(dailyOverrides()))).toBe(true);
      expect(check(resolved(dailyOverrides({ bookableDays: [] })))).toBe(false);
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
        check(resolved(dailyOverrides({ bookableDays: [weekdayOf(date)] }))),
      ).toBe(true);
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

  describe("childCanBeBooked", () => {
    test("true for an active, open, in-stock child", () => {
      expect(
        childCanBeBooked(
          resolved({ active: true, attendeeCount: 0, maxAttendees: 10 }),
        ),
      ).toBe(true);
    });

    test("false when inactive", () => {
      expect(childCanBeBooked(resolved({ active: false }))).toBe(false);
    });

    test("false when closed", () => {
      expect(childCanBeBooked(resolved({}, true))).toBe(false);
    });

    test("false when sold out", () => {
      expect(
        childCanBeBooked(resolved({ attendeeCount: 1, maxAttendees: 1 })),
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
});
