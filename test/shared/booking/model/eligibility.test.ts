import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookableChildIds,
  childActive,
  childCanBeBooked,
  childDateKey,
  childDateOk,
  childHasDateOrStockForDays,
  childHasPriceForDays,
  childInStock,
  childOpen,
  childPassesAllChecks,
  childUsesSameDays,
} from "#shared/booking/model.ts";
import {
  dailyOverrides,
  resolved,
  today,
  weekdayOf,
} from "#test/test-utils/booking-model-fixtures.ts";
import { useSetting } from "#test-utils/settings.ts";

describe("booking model — child eligibility", () => {
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
          resolved({ active: true, attendee_count: 0, max_attendees: 10 }),
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
        childCanBeBooked(resolved({ attendee_count: 1, max_attendees: 1 })),
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
