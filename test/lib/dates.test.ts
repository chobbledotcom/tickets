import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addDays,
  DAY_NAMES,
  daysAgo,
  eventDateToCalendarDate,
  formatDateLabel,
  formatDateRangeLabel,
  formatDateRangeLabelCompactEn,
  formatDatetimeLabel,
  formatDatetimeShort,
  getAvailableDates,
  getNextBookableDate,
  normalizeDatetime,
} from "#lib/dates.ts";
import { todayInTz } from "#lib/timezone.ts";
import { VALID_DAY_NAMES } from "#templates/fields.ts";
import { describeWithEnv, testEvent, testWithSetting } from "#test-utils";

const today = () => todayInTz("UTC");

describeWithEnv("dates", { db: true }, () => {
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
        bookable_days: ["Monday"],
        event_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(event, []);
      expect(dates.length).toBeGreaterThan(0);
      // Every returned date should be a Monday
      for (const d of dates) {
        const dayName = DAY_NAMES[new Date(`${d}T00:00:00Z`).getUTCDay()];
        expect(dayName).toBe("Monday");
      }
    });

    const dailyEventWithAllDays = () =>
      testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

    const makeHoliday = (name: string, start: string, end: string) => [
      { end_date: end, id: 1, name, start_date: start },
    ];

    test("excludes holidays", () => {
      const holidayDate = addDays(today(), 1);
      const dates = getAvailableDates(
        dailyEventWithAllDays(),
        makeHoliday("Holiday", holidayDate, holidayDate),
      );
      expect(dates).not.toContain(holidayDate);
    });

    test("excludes holiday ranges", () => {
      const holidayStart = addDays(today(), 1);
      const holidayEnd = addDays(today(), 3);
      const dates = getAvailableDates(
        dailyEventWithAllDays(),
        makeHoliday("Holiday Range", holidayStart, holidayEnd),
      );
      expect(dates).not.toContain(holidayStart);
      expect(dates).not.toContain(addDays(today(), 2));
      expect(dates).not.toContain(holidayEnd);
    });

    test("respects minimum_days_before", () => {
      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 3,
      });

      const dates = getAvailableDates(event, []);
      const earliest = dates[0]!;
      expect(earliest >= addDays(today(), 3)).toBe(true);
    });

    test("uses 730 days when maximum_days_after is 0 (unlimited)", () => {
      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 0,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(event, []);
      const latest = dates[dates.length - 1]!;
      // Should extend close to 730 days (2 years)
      expect(latest >= addDays(today(), 700)).toBe(true);
    });

    test("respects maximum_days_after when non-zero", () => {
      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(event, []);
      const latest = dates[dates.length - 1]!;
      expect(latest <= addDays(today(), 7)).toBe(true);
    });

    test("returns empty array when no bookable days match", () => {
      // Choose a day that doesn't appear in the 7-day range from today
      // by picking a bogus day name
      const event = testEvent({
        bookable_days: [],
        event_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      const dates = getAvailableDates(event, []);
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
      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        duration_days: 3,
        event_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });
      const dates = getAvailableDates(event, holidays);
      // day+1 start → covers day 1,2,3 → contains holidayStart → excluded
      expect(dates).not.toContain(addDays(today(), 1));
      // day+3 start is the holiday itself → excluded
      expect(dates).not.toContain(holidayStart);
      // day+4 start → covers day 4,5,6 → no holiday → included
      expect(dates).toContain(addDays(today(), 4));
    });
  });

  describe("formatDateRangeLabelCompactEn", () => {
    test("same day: single date with full year", () => {
      expect(formatDateRangeLabelCompactEn("2027-02-02", "2027-02-02")).toBe(
        "2 February 2027",
      );
    });

    test("same month same year: joins days with en dash", () => {
      expect(formatDateRangeLabelCompactEn("2027-02-02", "2027-02-03")).toBe(
        "2–3 February 2027",
      );
    });

    test("different month same year: keeps both months + trailing year", () => {
      expect(formatDateRangeLabelCompactEn("2027-02-02", "2027-03-03")).toBe(
        "2 February – 3 March 2027",
      );
    });

    test("different year: both years rendered", () => {
      expect(formatDateRangeLabelCompactEn("2027-02-02", "2028-02-03")).toBe(
        "2 February 2027 – 3 February 2028",
      );
    });
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
  });

  describe("getNextBookableDate", () => {
    test("returns the first available date", () => {
      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(event, []);
      expect(result).toBe(today());
    });

    test("returns null when no bookable days configured", () => {
      const event = testEvent({
        bookable_days: [],
        event_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      expect(getNextBookableDate(event, [])).toBeNull();
    });

    test("skips holidays", () => {
      const todayStr = today();
      const holidays = [
        { end_date: todayStr, id: 1, name: "Holiday", start_date: todayStr },
      ];

      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 7,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(event, holidays);
      expect(result).toBe(addDays(todayStr, 1));
    });

    test("respects minimum_days_before", () => {
      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 3,
      });

      const result = getNextBookableDate(event, []);
      expect(result).toBe(addDays(today(), 3));
    });

    test("returns null when all dates fall on holidays", () => {
      const start = addDays(today(), 1);
      const end = addDays(today(), 3);
      const holidays = [
        { end_date: end, id: 1, name: "Long Holiday", start_date: start },
      ];

      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 3,
        minimum_days_before: 1,
      });

      expect(getNextBookableDate(event, holidays)).toBeNull();
    });

    test("uses 730 days when maximum_days_after is 0", () => {
      const event = testEvent({
        bookable_days: [...VALID_DAY_NAMES],
        event_type: "daily",
        maximum_days_after: 0,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(event, []);
      expect(result).toBe(today());
    });

    test("returns first matching day when only specific days are bookable", () => {
      const event = testEvent({
        bookable_days: ["Monday"],
        event_type: "daily",
        maximum_days_after: 14,
        minimum_days_before: 0,
      });

      const result = getNextBookableDate(event, []);
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

  describe("eventDateToCalendarDate", () => {
    test("converts UTC datetime to YYYY-MM-DD in UTC", () => {
      expect(eventDateToCalendarDate("2026-06-15T14:00:00.000Z")).toBe(
        "2026-06-15",
      );
    });

    testWithSetting(
      "converts UTC datetime to local date in timezone",
      { timezone: "Europe/London" },
      () => {
        // 23:30 UTC on June 15 = 00:30 BST on June 16 (Europe/London in summer)
        expect(eventDateToCalendarDate("2026-06-15T23:30:00.000Z")).toBe(
          "2026-06-16",
        );
      },
    );

    test("returns null for empty string", () => {
      expect(eventDateToCalendarDate("")).toBeNull();
    });

    test("returns null for invalid datetime", () => {
      expect(eventDateToCalendarDate("not-a-date")).toBeNull();
    });

    testWithSetting(
      "returns null for invalid timezone",
      { timezone: "Invalid/Zone" },
      () => {
        expect(eventDateToCalendarDate("2026-06-15T14:00:00.000Z")).toBeNull();
      },
    );

    test("handles midnight UTC", () => {
      expect(eventDateToCalendarDate("2026-03-01T00:00:00.000Z")).toBe(
        "2026-03-01",
      );
    });

    test("pads single-digit month and day", () => {
      expect(eventDateToCalendarDate("2026-01-05T12:00:00.000Z")).toBe(
        "2026-01-05",
      );
    });
  });

  describe("daysAgo", () => {
    test("returns null for empty string", () => {
      expect(daysAgo("")).toBeNull();
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
        // Event at 16:00 UTC yesterday = 01:00 today in Tokyo → should be null (today)
        expect(daysAgo(`${yesterdayTokyo}T16:00:00.000Z`)).toBeNull();
      },
    );
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
