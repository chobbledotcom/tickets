import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addDays,
  addMonthsIso,
  calendarGridDates,
  DAY_NAMES,
  daysAgo,
  formatDateLabel,
  formatDateRangeLabel,
  formatDateRangeLabelCompactEn,
  formatDatetimeLabel,
  formatDatetimeShort,
  formatMonthLabel,
  formatTimeAgo,
  getAvailableDates,
  getNextBookableDate,
  isBookingRangeValid,
  listingDateToCalendarDate,
  monthsAround,
  normalizeDatetime,
  shiftMonth,
} from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { VALID_DAY_NAMES } from "#templates/fields.ts";
import { testListing, testWithSetting, useSetting } from "#test-utils";

const today = () => todayInTz("UTC");

describe("dates", () => {
  useSetting({ timezone: "UTC" });
  describe("addDays", () => {
    test("adds positive days to a date", () => {
      expect(addDays("2026-01-01", 5)).toBe("2026-01-06");
    });

    test("adds zero days returns same date", () => {
      expect(addDays("2026-06-15", 0)).toBe("2026-06-15");
    });

    test("handles month boundary", () => {
      expect(addDays("2026-01-30", 3)).toBe("2026-02-02");
    });

    test("handles year boundary", () => {
      expect(addDays("2026-12-30", 5)).toBe("2027-01-04");
    });

    test("handles large number of days", () => {
      expect(addDays("2026-01-01", 365)).toBe("2027-01-01");
    });
  });

  describe("addMonthsIso", () => {
    test("clamps Jan 31 + 1mo to Feb 28", () => {
      expect(addMonthsIso("2026-01-31T12:00:00.000Z", 1)).toBe(
        "2026-02-28T12:00:00.000Z",
      );
    });

    test("clamps Jan 31 + 1mo to Feb 29 in leap year", () => {
      expect(addMonthsIso("2024-01-31T12:00:00.000Z", 1)).toBe(
        "2024-02-29T12:00:00.000Z",
      );
    });

    test("clamps to Feb 28 in a non-leap century year (1900)", () => {
      // 1900 is divisible by 100 but not 400, so it is NOT a leap year.
      expect(addMonthsIso("1900-01-31T12:00:00.000Z", 1)).toBe(
        "1900-02-28T12:00:00.000Z",
      );
    });

    test("clamps to Feb 29 in a leap century year (2000)", () => {
      // 2000 is divisible by 400, so it IS a leap year.
      expect(addMonthsIso("2000-01-31T12:00:00.000Z", 1)).toBe(
        "2000-02-29T12:00:00.000Z",
      );
    });

    test("clamps Mar 31 + 1mo to Apr 30", () => {
      expect(addMonthsIso("2026-03-31T00:00:00.000Z", 1)).toBe(
        "2026-04-30T00:00:00.000Z",
      );
    });

    test("year rollover Dec 15 + 1mo", () => {
      expect(addMonthsIso("2026-12-15T00:00:00.000Z", 1)).toBe(
        "2027-01-15T00:00:00.000Z",
      );
    });

    test("12-month renewal", () => {
      expect(addMonthsIso("2026-05-17T00:00:00.000Z", 12)).toBe(
        "2027-05-17T00:00:00.000Z",
      );
    });

    test("zero months returns canonical ISO string", () => {
      expect(addMonthsIso("2026-05-17T09:30:00.000Z", 0)).toBe(
        "2026-05-17T09:30:00.000Z",
      );
    });

    test("preserves time component", () => {
      expect(addMonthsIso("2026-01-15T14:30:45.123Z", 2)).toBe(
        "2026-03-15T14:30:45.123Z",
      );
    });
  });

  describe("shiftMonth", () => {
    test("advances to the next month", () => {
      expect(shiftMonth("2026-07", 1)).toBe("2026-08");
    });

    test("steps back to the previous month", () => {
      expect(shiftMonth("2026-07", -1)).toBe("2026-06");
    });

    test("crosses the year boundary forward", () => {
      expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    });

    test("crosses the year boundary backward", () => {
      expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    });

    test("shifts by several months at once", () => {
      expect(shiftMonth("2026-07", 6)).toBe("2027-01");
    });
  });

  describe("formatMonthLabel", () => {
    test("formats a mid-year month", () => {
      expect(formatMonthLabel("2026-07")).toBe("July 2026");
    });

    test("formats January", () => {
      expect(formatMonthLabel("2026-01")).toBe("January 2026");
    });

    test("formats December", () => {
      expect(formatMonthLabel("2026-12")).toBe("December 2026");
    });
  });

  describe("monthsAround", () => {
    test("spans the requested years either side of the month's year", () => {
      const months = monthsAround("2026-03", 5);
      expect(months[0]).toBe("2021-01");
      expect(months[months.length - 1]).toBe("2031-12");
    });

    test("returns twelve months for every year in range", () => {
      expect(monthsAround("2026-03", 5)).toHaveLength(11 * 12);
    });

    test("centres on the year, ignoring the month part", () => {
      expect(monthsAround("2026-12", 1)).toEqual(monthsAround("2026-01", 1));
    });

    test("includes the centre month itself", () => {
      expect(monthsAround("2026-03", 5)).toContain("2026-03");
    });
  });

  describe("calendarGridDates", () => {
    test("starts on the Monday a full week before the month's first week", () => {
      // 1 March 2026 is a Sunday; its Monday is 23 Feb, minus one week = 16 Feb.
      expect(calendarGridDates("2026-03")[0]).toBe("2026-02-16");
    });

    test("ends on the Sunday a full week after the month's last week", () => {
      const grid = calendarGridDates("2026-03");
      expect(grid[grid.length - 1]).toBe("2026-04-12");
    });

    test("always spans whole weeks", () => {
      expect(calendarGridDates("2026-03").length % 7).toBe(0);
      expect(calendarGridDates("2026-07").length % 7).toBe(0);
      expect(calendarGridDates("2024-02").length % 7).toBe(0);
    });

    test("begins on a Monday and ends on a Sunday", () => {
      const grid = calendarGridDates("2026-07");
      expect(DAY_NAMES[new Date(`${grid[0]}T00:00:00Z`).getUTCDay()]).toBe(
        "Monday",
      );
      expect(
        DAY_NAMES[new Date(`${grid[grid.length - 1]}T00:00:00Z`).getUTCDay()],
      ).toBe("Sunday");
    });

    test("includes every day of the target month", () => {
      const grid = calendarGridDates("2026-07");
      expect(grid).toContain("2026-07-01");
      expect(grid).toContain("2026-07-31");
    });

    test("includes the leap day in a leap February", () => {
      expect(calendarGridDates("2024-02")).toContain("2024-02-29");
    });
  });

  describe("formatDateLabel", () => {
    test("formats a Monday date", () => {
      // 2026-02-09 is a Monday
      expect(formatDateLabel("2026-02-09")).toBe("Monday 9 February 2026");
    });

    test("formats a Saturday date", () => {
      // 2026-02-14 is a Saturday
      expect(formatDateLabel("2026-02-14")).toBe("Saturday 14 February 2026");
    });

    test("formats a Sunday date", () => {
      // 2026-02-15 is a Sunday
      expect(formatDateLabel("2026-02-15")).toBe("Sunday 15 February 2026");
    });

    test("formats dates across different months", () => {
      // 2026-12-25 is a Friday
      expect(formatDateLabel("2026-12-25")).toBe("Friday 25 December 2026");
    });
  });

  describe("getAvailableDates", () => {
    /** A daily listing with a 5-day duration, full week, wide date range —
     *  the fixture two duration-override tests share. */
    const dailyOverrideListing = () =>
      testListing({
        bookable_days: [...VALID_DAY_NAMES],
        duration_days: 5,
        listing_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });

    /** A single-day holiday on `date`. */
    const holidayOn = (date: string) => ({
      end_date: date,
      id: 1,
      name: "H",
      start_date: date,
    });

    test("returns dates filtered by bookable days", () => {
      const listing = testListing({
        bookable_days: ["Monday"],
        listing_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(listing, []);
      expect(dates.length).toBeGreaterThan(0);
      // Every returned date should be a Monday
      for (const d of dates) {
        const dayName = DAY_NAMES[new Date(`${d}T00:00:00Z`).getUTCDay()];
        expect(dayName).toBe("Monday");
      }
    });

    const dailyListingWithAllDays = () =>
      testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

    const makeHoliday = (name: string, start: string, end: string) => [
      { end_date: end, id: 1, name, start_date: start },
    ];

    test("excludes holidays", () => {
      const holidayDate = addDays(today(), 1);
      const dates = getAvailableDates(
        dailyListingWithAllDays(),
        makeHoliday("Holiday", holidayDate, holidayDate),
      );
      expect(dates).not.toContain(holidayDate);
    });

    test("excludes holiday ranges", () => {
      const holidayStart = addDays(today(), 1);
      const holidayEnd = addDays(today(), 3);
      const dates = getAvailableDates(
        dailyListingWithAllDays(),
        makeHoliday("Holiday Range", holidayStart, holidayEnd),
      );
      expect(dates).not.toContain(holidayStart);
      expect(dates).not.toContain(addDays(today(), 2));
      expect(dates).not.toContain(holidayEnd);
    });

    test("respects minimum_days_before", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 3,
      });

      const dates = getAvailableDates(listing, []);
      const earliest = dates[0]!;
      expect(earliest >= addDays(today(), 3)).toBe(true);
    });

    test("uses 730 days when maximum_days_after is 0 (unlimited)", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 0,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(listing, []);
      const latest = dates[dates.length - 1]!;
      // Should extend close to 730 days (2 years)
      expect(latest >= addDays(today(), 700)).toBe(true);
    });

    test("respects maximum_days_after when non-zero", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(listing, []);
      const latest = dates[dates.length - 1]!;
      expect(latest <= addDays(today(), 7)).toBe(true);
    });

    test("returns empty array when no bookable days match", () => {
      // Choose a day that doesn't appear in the 7-day range from today
      // by picking a bogus day name
      const listing = testListing({
        bookable_days: [],
        listing_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(listing, []);
      expect(dates).toEqual([]);
    });

    test("excludes multi-day start dates whose range covers a holiday", () => {
      const holidayStart = addDays(today(), 3);
      const holidays = [
        {
          end_date: holidayStart,
          id: 1,
          name: "Conflict",
          start_date: holidayStart,
        },
      ];
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        duration_days: 3,
        listing_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });
      const dates = getAvailableDates(listing, holidays);
      // day+1 start → covers day 1,2,3 → contains holidayStart → excluded
      expect(dates).not.toContain(addDays(today(), 1));
      // day+3 start is the holiday itself → excluded
      expect(dates).not.toContain(holidayStart);
      // day+4 start → covers day 4,5,6 → no holiday → included
      expect(dates).toContain(addDays(today(), 4));
    });

    test("durationOverride filters by the given span instead of duration_days", () => {
      // duration_days is the max (5), but a customisable listing's date list is
      // built for a single day so every individually-bookable start appears.
      const holidayDay = addDays(today(), 2);
      const listing = dailyOverrideListing();
      const holidays = [holidayOn(holidayDay)];
      // With the listing's own duration (5), the day+1 start spans the holiday
      // and is excluded; with an override of 1 it is offered.
      expect(getAvailableDates(listing, holidays)).not.toContain(
        addDays(today(), 1),
      );
      expect(getAvailableDates(listing, holidays, 1)).toContain(
        addDays(today(), 1),
      );
    });

    test("durationOverride of 0 is clamped to one day, not treated as absent", () => {
      // An explicit 0 is a provided override (clamped to the 1-day minimum),
      // distinct from omitting it (which falls back to duration_days). This is
      // the `??` (not `||`) contract: `0 ?? duration_days` keeps the 0.
      const holidayDay = addDays(today(), 2);
      const listing = dailyOverrideListing();
      const holidays = [holidayOn(holidayDay)];
      // Override 0 → 1-day span, so the day+1 start clears the day+2 holiday and
      // is offered. Were 0 mistaken for "absent" it would use duration_days (5),
      // span the holiday, and be excluded.
      expect(getAvailableDates(listing, holidays, 0)).toContain(
        addDays(today(), 1),
      );
    });
  });

  describe("isBookingRangeValid", () => {
    const dailyAllDays = () =>
      testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 0,
      });

    test("accepts a holiday-free range within the booking window", () => {
      expect(isBookingRangeValid(dailyAllDays(), today(), 3, [])).toBe(true);
    });

    test("rejects a range that overlaps a holiday", () => {
      const holidayDay = addDays(today(), 2);
      const holidays = [
        { end_date: holidayDay, id: 1, name: "H", start_date: holidayDay },
      ];
      expect(isBookingRangeValid(dailyAllDays(), today(), 3, holidays)).toBe(
        false,
      );
    });

    test("rejects a range that runs past the booking window", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 2,
        minimum_days_before: 0,
      });
      expect(isBookingRangeValid(listing, today(), 5, [])).toBe(false);
    });

    test("rejects a start date before the earliest bookable date", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 2,
      });
      // today is before today+2 (minimum_days_before), so it's too early.
      expect(isBookingRangeValid(listing, today(), 1, [])).toBe(false);
    });

    test("rejects a range that hits a non-bookable weekday", () => {
      // Only Mondays are bookable, so a 2-day span from a Monday includes
      // Tuesday and must be rejected.
      const listing = testListing({
        bookable_days: ["Monday"],
        listing_type: "daily",
        maximum_days_after: 21,
        minimum_days_before: 0,
      });
      const monday = getAvailableDates(listing, [])[0]!;
      expect(isBookingRangeValid(listing, monday, 2, [])).toBe(false);
    });
  });

  describe("formatDateRangeLabelCompactEn", () => {
    const cases: [label: string, start: string, end: string, out: string][] = [
      ["same day", "2027-02-02", "2027-02-02", "2 February 2027"],
      ["same month + year", "2027-02-02", "2027-02-03", "2–3 February 2027"],
      [
        "cross-month, same year",
        "2027-02-02",
        "2027-03-03",
        "2 February – 3 March 2027",
      ],
      [
        "cross-year",
        "2027-02-02",
        "2028-02-03",
        "2 February 2027 – 3 February 2028",
      ],
    ];
    for (const [label, start, end, out] of cases) {
      test(label, () => {
        expect(formatDateRangeLabelCompactEn(start, end)).toBe(out);
      });
    }
  });

  describe("formatDateRangeLabel", () => {
    test("returns single-day label when duration is 1 day", () => {
      expect(
        formatDateRangeLabel(
          "2026-02-09T00:00:00Z",
          "2026-02-10T00:00:00.000Z",
        ),
      ).toBe("Monday 9 February 2026");
    });

    test("returns compact range when duration is multi-day", () => {
      expect(
        formatDateRangeLabel(
          "2027-02-02T00:00:00Z",
          "2027-02-05T00:00:00.000Z",
        ),
      ).toBe("2–4 February 2027");
    });

    test("returns empty string when start is null", () => {
      expect(formatDateRangeLabel(null, null)).toBe("");
    });

    test("collapses to single-day label when end is null but start is set", () => {
      // Defensive path for rows that somehow have start_at but no end_at —
      // callers in the admin template still render something sensible.
      expect(formatDateRangeLabel("2026-02-09T00:00:00Z", null)).toBe(
        "Monday 9 February 2026",
      );
    });
  });

  describe("getNextBookableDate", () => {
    test("returns the first available date", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(listing, []);
      expect(result).toBe(today());
    });

    test("returns null when no bookable days configured", () => {
      const listing = testListing({
        bookable_days: [],
        listing_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      expect(getNextBookableDate(listing, [])).toBeNull();
    });

    test("skips start dates whose multi-day range extends past the window", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        duration_days: 3,
        listing_type: "daily",
        maximum_days_after: 4,
        minimum_days_before: 0,
      });
      const result = getNextBookableDate(listing, []);
      expect(result).toBe(today());
      const dates = getAvailableDates(listing, []);
      // A 3-day booking can only start on days 0, 1, or 2 — day 3 and 4
      // can't fit a 3-day range within the 4-day window.
      expect(dates.length).toBeLessThanOrEqual(3);
      expect(dates).not.toContain(addDays(today(), 4));
    });

    test("skips holidays", () => {
      const todayStr = today();
      const holidays = [
        { end_date: todayStr, id: 1, name: "Holiday", start_date: todayStr },
      ];

      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(listing, holidays);
      expect(result).toBe(addDays(todayStr, 1));
    });

    test("respects minimum_days_before", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 3,
      });

      const result = getNextBookableDate(listing, []);
      expect(result).toBe(addDays(today(), 3));
    });

    test("returns null when all dates fall on holidays", () => {
      const start = addDays(today(), 1);
      const end = addDays(today(), 3);
      const holidays = [
        { end_date: end, id: 1, name: "Long Holiday", start_date: start },
      ];

      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 3,
        minimum_days_before: 1,
      });

      expect(getNextBookableDate(listing, holidays)).toBeNull();
    });

    test("uses 730 days when maximum_days_after is 0", () => {
      const listing = testListing({
        bookable_days: [...VALID_DAY_NAMES],
        listing_type: "daily",
        maximum_days_after: 0,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(listing, []);
      expect(result).toBe(today());
    });

    test("returns first matching day when only specific days are bookable", () => {
      const listing = testListing({
        bookable_days: ["Monday"],
        listing_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(listing, []);
      expect(result).not.toBeNull();
      const dayName = DAY_NAMES[new Date(`${result}T00:00:00Z`).getUTCDay()];
      expect(dayName).toBe("Monday");
    });
  });

  describe("normalizeDatetime", () => {
    test("normalizes datetime-local (16 chars) to full ISO string", () => {
      const result = normalizeDatetime("2026-06-15T14:30", "date");
      expect(result).toBe("2026-06-15T14:30:00.000Z");
    });

    test("handles datetime with seconds", () => {
      const result = normalizeDatetime("2026-06-15T14:30:00", "date");
      expect(result).toBe("2026-06-15T14:30:00.000Z");
    });

    test("throws on invalid datetime string", () => {
      expect(() => normalizeDatetime("not-a-date", "date")).toThrow(
        "Invalid date",
      );
    });

    test("includes the label in the error message", () => {
      expect(() => normalizeDatetime("bad-value", "closes_at")).toThrow(
        "Invalid closes_at",
      );
    });

    testWithSetting(
      "converts datetime-local to UTC using timezone",
      { timezone: "Europe/London" },
      () => {
        // 14:30 BST (June) = 13:30 UTC
        const result = normalizeDatetime("2026-06-15T14:30", "date");
        expect(result).toBe("2026-06-15T13:30:00.000Z");
      },
    );
  });

  describe("listingDateToCalendarDate", () => {
    test("converts UTC datetime to YYYY-MM-DD in UTC", () => {
      expect(listingDateToCalendarDate("2026-06-15T14:00:00.000Z")).toBe(
        "2026-06-15",
      );
    });

    testWithSetting(
      "converts UTC datetime to local date in timezone",
      { timezone: "Europe/London" },
      () => {
        // 23:30 UTC on June 15 = 00:30 BST on June 16 (Europe/London in summer)
        expect(listingDateToCalendarDate("2026-06-15T23:30:00.000Z")).toBe(
          "2026-06-16",
        );
      },
    );

    test("returns null for empty string", () => {
      expect(listingDateToCalendarDate("")).toBeNull();
    });

    test("returns null for invalid datetime", () => {
      expect(listingDateToCalendarDate("not-a-date")).toBeNull();
    });

    testWithSetting(
      "returns null for invalid timezone",
      { timezone: "Invalid/Zone" },
      () => {
        expect(
          listingDateToCalendarDate("2026-06-15T14:00:00.000Z"),
        ).toBeNull();
      },
    );

    test("handles midnight UTC", () => {
      expect(listingDateToCalendarDate("2026-03-01T00:00:00.000Z")).toBe(
        "2026-03-01",
      );
    });

    test("pads single-digit month and day", () => {
      expect(listingDateToCalendarDate("2026-01-05T12:00:00.000Z")).toBe(
        "2026-01-05",
      );
    });
  });

  describe("daysAgo", () => {
    test("returns null for empty string", () => {
      expect(daysAgo("")).toBeNull();
    });

    test("returns null for an invalid date", () => {
      expect(daysAgo("not-a-date")).toBeNull();
    });

    test("returns null for today's date", () => {
      const todayStr = today();
      expect(daysAgo(`${todayStr}T12:00:00.000Z`)).toBeNull();
    });

    test("returns null for future date", () => {
      const futureStr = addDays(today(), 5);
      expect(daysAgo(`${futureStr}T12:00:00.000Z`)).toBeNull();
    });

    test("returns 1 for yesterday", () => {
      const yesterdayStr = addDays(today(), -1);
      expect(daysAgo(`${yesterdayStr}T12:00:00.000Z`)).toBe(1);
    });

    test("returns correct count for multiple days ago", () => {
      const pastStr = addDays(today(), -10);
      expect(daysAgo(`${pastStr}T12:00:00.000Z`)).toBe(10);
    });

    testWithSetting(
      "respects timezone when determining past date",
      { timezone: "Asia/Tokyo" },
      () => {
        // Asia/Tokyo is UTC+9, so 16:00 UTC = 01:00 next day in Tokyo
        const todayTokyo = todayInTz("Asia/Tokyo");
        const yesterdayTokyo = addDays(todayTokyo, -1);
        // Listing at 16:00 UTC yesterday = 01:00 today in Tokyo → should be null (today)
        expect(daysAgo(`${yesterdayTokyo}T16:00:00.000Z`)).toBeNull();
      },
    );
  });

  describe("formatTimeAgo", () => {
    const base = Date.parse("2026-06-15T12:00:00.000Z");

    test("returns null for an unparseable timestamp", () => {
      expect(formatTimeAgo("not-a-date", base)).toBeNull();
    });

    test("returns null for a future timestamp", () => {
      expect(formatTimeAgo("2026-06-15T12:00:01.000Z", base)).toBeNull();
    });

    test("labels a sub-minute span in seconds", () => {
      expect(formatTimeAgo("2026-06-15T11:59:30.000Z", base)).toBe(
        "30 seconds ago",
      );
    });

    test("uses 'now' at zero elapsed", () => {
      expect(formatTimeAgo("2026-06-15T12:00:00.000Z", base)).toBe("now");
    });

    test("uses singular minute at exactly one minute", () => {
      expect(formatTimeAgo("2026-06-15T11:59:00.000Z", base)).toBe(
        "1 minute ago",
      );
    });

    test("pluralises minutes", () => {
      expect(formatTimeAgo("2026-06-15T11:45:00.000Z", base)).toBe(
        "15 minutes ago",
      );
    });

    test("uses singular hour at exactly one hour", () => {
      expect(formatTimeAgo("2026-06-15T11:00:00.000Z", base)).toBe(
        "1 hour ago",
      );
    });

    test("pluralises hours", () => {
      expect(formatTimeAgo("2026-06-15T09:00:00.000Z", base)).toBe(
        "3 hours ago",
      );
    });

    test("uses 'yesterday' at exactly one day", () => {
      expect(formatTimeAgo("2026-06-14T12:00:00.000Z", base)).toBe("yesterday");
    });

    test("pluralises days", () => {
      expect(formatTimeAgo("2026-06-13T12:00:00.000Z", base)).toBe(
        "2 days ago",
      );
    });
  });

  describe("formatDatetimeLabel", () => {
    test("formats ISO datetime as human-readable string", () => {
      expect(formatDatetimeLabel("2026-06-15T14:00:00.000Z")).toContain(
        "Monday 15 June 2026 at 14:00",
      );
    });

    test("pads single-digit hours and minutes", () => {
      expect(formatDatetimeLabel("2026-01-05T09:05:00.000Z")).toContain(
        "Monday 5 January 2026 at 09:05",
      );
    });

    test("handles midnight", () => {
      expect(formatDatetimeLabel("2026-03-01T00:00:00.000Z")).toContain(
        "Sunday 1 March 2026 at 00:00",
      );
    });
  });

  describe("formatDatetimeShort", () => {
    testWithSetting(
      "uses configured timezone (Europe/London BST)",
      { timezone: "Europe/London" },
      () => {
        // 13:00 UTC on 7 April 2026 is during BST (UTC+1) → 14:00 local
        expect(formatDatetimeShort("2026-04-07T13:00:00.000Z")).toBe(
          "2026-04-07 14:00",
        );
      },
    );

    testWithSetting(
      "uses configured timezone (Europe/London GMT)",
      { timezone: "Europe/London" },
      () => {
        expect(formatDatetimeShort("2026-01-15T09:05:00.000Z")).toBe(
          "2026-01-15 09:05",
        );
      },
    );

    testWithSetting(
      "uses configured timezone (Asia/Tokyo)",
      { timezone: "Asia/Tokyo" },
      () => {
        expect(formatDatetimeShort("2026-06-15T05:30:00.000Z")).toBe(
          "2026-06-15 14:30",
        );
      },
    );
  });
});
