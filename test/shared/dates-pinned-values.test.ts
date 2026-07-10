/**
 * Pins exact outputs of the date helpers so small slips can't hide: every
 * day and month name in a rendered label, the Monday-first day list, hour
 * rounding, calendar-grid boundaries, and booked-range arithmetic. Each
 * assertion here exists to fail under a specific one-token change that the
 * broader behaviour tests in dates.test.ts did not distinguish.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addMonthsIso,
  bookedRangeLabel,
  bookedSpanDays,
  calendarGridDates,
  DAY_NAMES,
  formatDateLabel,
  getBookableStartDates,
  startOfHour,
  VALID_DAY_NAMES,
  widestDatedEntry,
} from "#shared/dates.ts";
import { testListing, useSetting } from "#test-utils";

describe("dates — pinned values", () => {
  useSetting({ timezone: "UTC" });

  test("a full week of labels names every day exactly", () => {
    // 2026-03-01 is a Sunday, so this week walks DAY_NAMES in order.
    const labels = [1, 2, 3, 4, 5, 6, 7].map((day) =>
      formatDateLabel(`2026-03-0${day}`),
    );
    expect(labels).toEqual([
      "Sunday 1 March 2026",
      "Monday 2 March 2026",
      "Tuesday 3 March 2026",
      "Wednesday 4 March 2026",
      "Thursday 5 March 2026",
      "Friday 6 March 2026",
      "Saturday 7 March 2026",
    ]);
  });

  test("labels name every month of the year", () => {
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    for (const [index, month] of monthNames.entries()) {
      const iso = `2026-${String(index + 1).padStart(2, "0")}-15`;
      expect(formatDateLabel(iso)).toContain(` 15 ${month} 2026`);
    }
  });

  test("VALID_DAY_NAMES is the Monday-first rotation of DAY_NAMES", () => {
    expect(VALID_DAY_NAMES).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    expect(DAY_NAMES[0]).toBe("Sunday");
  });

  test("adding months clamps a month-end start to each target month's length", () => {
    // From 31 January, every non-leap target month clamps to its true length.
    const expectedDays = [28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (const [index, day] of expectedDays.entries()) {
      expect(addMonthsIso("2026-01-31T12:00:00.000Z", index + 1)).toBe(
        `2026-${String(index + 2).padStart(2, "0")}-${day}T12:00:00.000Z`,
      );
    }
  });

  test("startOfHour zeroes minutes, seconds and milliseconds but keeps the hour", () => {
    const rounded = startOfHour(new Date("2026-07-10T13:47:23.456Z"));
    expect(rounded.toISOString()).toBe("2026-07-10T13:00:00.000Z");
  });

  test("the calendar grid for a Sunday-ending month stops one week after it", () => {
    // May 2026 ends on a Sunday — the exact case where a one-day slip in the
    // month's last day would stretch the padding a whole extra week.
    const grid = calendarGridDates("2026-05");
    expect(grid[0]).toBe("2026-04-20");
    expect(grid.at(-1)).toBe("2026-06-07");
    expect(grid.length).toBe(49);
  });

  test("customisable-days listings offer late starts their fixed duration would exclude", () => {
    const base = {
      bookable_days: [...VALID_DAY_NAMES],
      duration_days: 3,
      listing_type: "daily" as const,
      maximum_days_after: 4,
      minimum_days_before: 0,
    };
    const flexible = getBookableStartDates(
      testListing({ ...base, customisable_days: true }),
      [],
    );
    const fixed = getBookableStartDates(
      testListing({ ...base, customisable_days: false }),
      [],
    );
    expect(flexible.length).toBeGreaterThan(fixed.length);
    expect(flexible.at(-1)! > fixed.at(-1)!).toBe(true);
  });

  test("a booking with no stored range spans exactly one day", () => {
    expect(bookedSpanDays(null, null)).toBe(1);
  });

  test("the booked-range label ends the day before the exclusive end date", () => {
    expect(bookedRangeLabel("2026-07-01", "2026-07-03")).toBe(
      "1–2 July 2026",
    );
  });

  test("the widest dated entry is the latest end date, not the latest entry", () => {
    const entry = (date: string, end: string | null) => ({
      attendee: { date, end_date: end },
    });
    const first = entry("2026-01-01", "2026-01-05");
    const widest = entry("2026-01-02", "2026-01-10");
    const later = entry("2026-01-03", "2026-01-07");
    expect(widestDatedEntry([first, widest, later])).toBe(widest);
  });
});
