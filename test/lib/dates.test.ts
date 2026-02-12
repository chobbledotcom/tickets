import { describe, expect, test } from "#test-compat";
import { addDays, DAY_NAMES, formatDateLabel, formatDatetimeLabel, getAvailableDates, normalizeDatetime } from "#lib/dates.ts";
import { todayInTz } from "#lib/timezone.ts";
import { testEvent } from "#test-utils";

const TZ = "UTC";
const today = () => todayInTz(TZ);

describe("dates", () => {
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
    test("returns dates filtered by bookable days", () => {
      const event = testEvent({
        event_type: "daily",
        bookable_days: JSON.stringify(["Monday"]),
        minimum_days_before: 0,
        maximum_days_after: 14,
      });

      const dates = getAvailableDates(event, [], TZ);
      expect(dates.length).toBeGreaterThan(0);
      // Every returned date should be a Monday
      for (const d of dates) {
        const dayName = DAY_NAMES[new Date(`${d}T00:00:00Z`).getUTCDay()];
        expect(dayName).toBe("Monday");
      }
    });

    test("excludes holidays", () => {
      // Pick a date range that includes "today + 1" as a holiday
      const holidayDate = addDays(today(), 1);
      const holidays = [{ id: 1, name: "Holiday", start_date: holidayDate, end_date: holidayDate }];

      const event = testEvent({
        event_type: "daily",
        bookable_days: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimum_days_before: 0,
        maximum_days_after: 7,
      });

      const dates = getAvailableDates(event, holidays, TZ);
      expect(dates).not.toContain(holidayDate);
    });

    test("excludes holiday ranges", () => {
      const holidayStart = addDays(today(), 1);
      const holidayEnd = addDays(today(), 3);
      const holidays = [{ id: 1, name: "Holiday Range", start_date: holidayStart, end_date: holidayEnd }];

      const event = testEvent({
        event_type: "daily",
        bookable_days: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimum_days_before: 0,
        maximum_days_after: 7,
      });

      const dates = getAvailableDates(event, holidays, TZ);
      expect(dates).not.toContain(holidayStart);
      expect(dates).not.toContain(addDays(today(), 2));
      expect(dates).not.toContain(holidayEnd);
    });

    test("respects minimum_days_before", () => {
      const event = testEvent({
        event_type: "daily",
        bookable_days: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimum_days_before: 3,
        maximum_days_after: 10,
      });

      const dates = getAvailableDates(event, [], TZ);
      const earliest = dates[0]!;
      expect(earliest >= addDays(today(), 3)).toBe(true);
    });

    test("uses 730 days when maximum_days_after is 0 (unlimited)", () => {
      const event = testEvent({
        event_type: "daily",
        bookable_days: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimum_days_before: 0,
        maximum_days_after: 0,
      });

      const dates = getAvailableDates(event, [], TZ);
      const latest = dates[dates.length - 1]!;
      // Should extend close to 730 days (2 years)
      expect(latest >= addDays(today(), 700)).toBe(true);
    });

    test("respects maximum_days_after when non-zero", () => {
      const event = testEvent({
        event_type: "daily",
        bookable_days: JSON.stringify(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]),
        minimum_days_before: 0,
        maximum_days_after: 7,
      });

      const dates = getAvailableDates(event, [], TZ);
      const latest = dates[dates.length - 1]!;
      expect(latest <= addDays(today(), 7)).toBe(true);
    });

    test("returns empty array when no bookable days match", () => {
      // Choose a day that doesn't appear in the 7-day range from today
      // by picking a bogus day name
      const event = testEvent({
        event_type: "daily",
        bookable_days: JSON.stringify([]),
        minimum_days_before: 0,
        maximum_days_after: 7,
      });

      const dates = getAvailableDates(event, [], TZ);
      expect(dates).toEqual([]);
    });
  });

  describe("normalizeDatetime", () => {
    test("normalizes datetime-local (16 chars) to full ISO string", () => {
      const result = normalizeDatetime("2026-06-15T14:30", "date", TZ);
      expect(result).toBe("2026-06-15T14:30:00.000Z");
    });

    test("passes through already-normalized ISO string", () => {
      const result = normalizeDatetime("2026-06-15T14:30:00.000Z", "date", TZ);
      expect(result).toBe("2026-06-15T14:30:00.000Z");
    });

    test("throws on invalid datetime string", () => {
      expect(() => normalizeDatetime("not-a-date", "date", TZ)).toThrow("Invalid date");
    });

    test("includes the label in the error message", () => {
      expect(() => normalizeDatetime("bad-value", "closes_at", TZ)).toThrow("Invalid closes_at");
    });

    test("converts datetime-local to UTC using timezone", () => {
      // 14:30 BST (June) = 13:30 UTC
      const result = normalizeDatetime("2026-06-15T14:30", "date", "Europe/London");
      expect(result).toBe("2026-06-15T13:30:00.000Z");
    });
  });

  describe("formatDatetimeLabel", () => {
    test("formats ISO datetime as human-readable string", () => {
      expect(formatDatetimeLabel("2026-06-15T14:00:00.000Z", TZ)).toContain(
        "Monday 15 June 2026 at 14:00",
      );
    });

    test("pads single-digit hours and minutes", () => {
      expect(formatDatetimeLabel("2026-01-05T09:05:00.000Z", TZ)).toContain(
        "Monday 5 January 2026 at 09:05",
      );
    });

    test("handles midnight", () => {
      expect(formatDatetimeLabel("2026-03-01T00:00:00.000Z", TZ)).toContain(
        "Sunday 1 March 2026 at 00:00",
      );
    });
  });
});
