import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  calendarGridDates,
  formatDateLabel,
  formatDateRangeLabel,
  formatDateRangeLabelCompactEn,
  formatMonthLabel,
  monthsAround,
  shiftMonth,
} from "#shared/date-labels.ts";
import { DAY_NAMES } from "#shared/day-names.ts";
import { useSetting } from "#test-utils/settings.ts";

describe("dates", () => {
  useSetting({ timezone: "UTC" });

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
});
