import { describe, expect, test } from "#test-compat";
import {
  DEFAULT_TIMEZONE,
  formatDatetimeInTz,
  isValidDatetime,
  isValidTimezone,
  localToUtc,
  todayInTz,
  utcToLocalInput,
} from "#lib/timezone.ts";

describe("timezone", () => {
  describe("DEFAULT_TIMEZONE", () => {
    test("is Europe/London", () => {
      expect(DEFAULT_TIMEZONE).toBe("Europe/London");
    });
  });

  describe("todayInTz", () => {
    test("returns a YYYY-MM-DD string", () => {
      const result = todayInTz("Europe/London");
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("returns same date for same timezone", () => {
      const a = todayInTz("UTC");
      const b = todayInTz("UTC");
      expect(a).toBe(b);
    });
  });

  describe("localToUtc", () => {
    test("converts datetime-local in UTC to same UTC", () => {
      const result = localToUtc("2026-06-15T14:30", "UTC");
      expect(result).toBe("2026-06-15T14:30:00.000Z");
    });

    test("converts London winter time (GMT, UTC+0) correctly", () => {
      // In January, Europe/London is GMT (UTC+0)
      const result = localToUtc("2026-01-15T14:30", "Europe/London");
      expect(result).toBe("2026-01-15T14:30:00.000Z");
    });

    test("converts London summer time (BST, UTC+1) correctly", () => {
      // In June, Europe/London is BST (UTC+1)
      // 14:30 BST = 13:30 UTC
      const result = localToUtc("2026-06-15T14:30", "Europe/London");
      expect(result).toBe("2026-06-15T13:30:00.000Z");
    });

    test("converts America/New_York winter time (EST, UTC-5) correctly", () => {
      // In January, New York is EST (UTC-5)
      // 14:30 EST = 19:30 UTC
      const result = localToUtc("2026-01-15T14:30", "America/New_York");
      expect(result).toBe("2026-01-15T19:30:00.000Z");
    });

    test("converts Asia/Tokyo (JST, UTC+9) correctly", () => {
      // Tokyo is always UTC+9
      // 14:30 JST = 05:30 UTC
      const result = localToUtc("2026-06-15T14:30", "Asia/Tokyo");
      expect(result).toBe("2026-06-15T05:30:00.000Z");
    });

    test("handles date boundary crossing (next day in UTC)", () => {
      // 23:30 in UTC+1 = 22:30 UTC (same day)
      const result = localToUtc("2026-06-15T23:30", "Europe/London");
      expect(result).toBe("2026-06-15T22:30:00.000Z");
    });

    test("handles date boundary crossing (previous day in UTC)", () => {
      // 01:00 UTC-5 (EST) = 06:00 UTC (same day)
      const result = localToUtc("2026-01-15T01:00", "America/New_York");
      expect(result).toBe("2026-01-15T06:00:00.000Z");
    });

    test("throws on invalid datetime", () => {
      expect(() => localToUtc("not-a-date", "UTC")).toThrow("Invalid datetime");
    });

    test("handles DST spring-forward gap with 'compatible' disambiguation", () => {
      // 2026-03-29 01:30 Europe/London doesn't exist (clocks skip from 01:00 GMT to 02:00 BST)
      // 'compatible' maps to the later (post-transition) interpretation: 02:30 BST = 01:30 UTC
      const result = localToUtc("2026-03-29T01:30", "Europe/London");
      expect(result).toBe("2026-03-29T01:30:00.000Z");
    });

    test("handles DST fall-back overlap with 'compatible' disambiguation", () => {
      // 2026-10-25 01:30 Europe/London exists twice:
      //   01:30 BST (earlier) = 00:30 UTC
      //   01:30 GMT (later)   = 01:30 UTC
      // 'compatible' picks the earlier occurrence during fall-back
      const result = localToUtc("2026-10-25T01:30", "Europe/London");
      expect(result).toBe("2026-10-25T00:30:00.000Z");
    });
  });

  describe("formatDatetimeInTz", () => {
    test("formats UTC datetime in London winter time (GMT)", () => {
      const result = formatDatetimeInTz("2026-01-15T14:30:00.000Z", "Europe/London");
      expect(result).toContain("Thursday 15 January 2026 at 14:30");
      expect(result).toContain("GMT");
    });

    test("formats UTC datetime in London summer time (BST)", () => {
      // 13:30 UTC = 14:30 BST
      const result = formatDatetimeInTz("2026-06-15T13:30:00.000Z", "Europe/London");
      expect(result).toContain("Monday 15 June 2026 at 14:30");
    });

    test("formats UTC datetime in Tokyo", () => {
      // 05:30 UTC = 14:30 JST
      const result = formatDatetimeInTz("2026-06-15T05:30:00.000Z", "Asia/Tokyo");
      expect(result).toContain("Monday 15 June 2026 at 14:30");
    });

    test("pads single-digit hours and minutes", () => {
      const result = formatDatetimeInTz("2026-01-05T09:05:00.000Z", "UTC");
      expect(result).toContain("Monday 5 January 2026 at 09:05");
      expect(result).toContain("UTC");
    });
  });

  describe("utcToLocalInput", () => {
    test("converts UTC to datetime-local in UTC", () => {
      const result = utcToLocalInput("2026-06-15T14:30:00.000Z", "UTC");
      expect(result).toBe("2026-06-15T14:30");
    });

    test("converts UTC to London summer time", () => {
      // 13:30 UTC = 14:30 BST
      const result = utcToLocalInput("2026-06-15T13:30:00.000Z", "Europe/London");
      expect(result).toBe("2026-06-15T14:30");
    });

    test("converts UTC to London winter time", () => {
      // 14:30 UTC = 14:30 GMT
      const result = utcToLocalInput("2026-01-15T14:30:00.000Z", "Europe/London");
      expect(result).toBe("2026-01-15T14:30");
    });

    test("converts UTC to Tokyo time", () => {
      // 05:30 UTC = 14:30 JST
      const result = utcToLocalInput("2026-06-15T05:30:00.000Z", "Asia/Tokyo");
      expect(result).toBe("2026-06-15T14:30");
    });

    test("handles date boundary crossing", () => {
      // 23:00 UTC = next day 08:00 JST
      const result = utcToLocalInput("2026-06-15T23:00:00.000Z", "Asia/Tokyo");
      expect(result).toBe("2026-06-16T08:00");
    });
  });

  describe("isValidTimezone", () => {
    test("accepts valid IANA timezone", () => {
      expect(isValidTimezone("Europe/London")).toBe(true);
    });

    test("accepts UTC", () => {
      expect(isValidTimezone("UTC")).toBe(true);
    });

    test("accepts America/New_York", () => {
      expect(isValidTimezone("America/New_York")).toBe(true);
    });

    test("rejects invalid timezone", () => {
      expect(isValidTimezone("Invalid/Timezone")).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isValidTimezone("")).toBe(false);
    });

    test("rejects random string", () => {
      expect(isValidTimezone("not-a-timezone")).toBe(false);
    });
  });

  describe("isValidDatetime", () => {
    test("accepts valid datetime-local format", () => {
      expect(isValidDatetime("2026-06-15T14:30")).toBe(true);
    });

    test("accepts datetime with seconds", () => {
      expect(isValidDatetime("2026-06-15T14:30:00")).toBe(true);
    });

    test("rejects invalid datetime", () => {
      expect(isValidDatetime("not-a-date")).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isValidDatetime("")).toBe(false);
    });
  });

  describe("round-trip: localToUtc -> utcToLocalInput", () => {
    test("round-trips correctly in BST", () => {
      const input = "2026-06-15T14:30";
      const utc = localToUtc(input, "Europe/London");
      const roundTripped = utcToLocalInput(utc, "Europe/London");
      expect(roundTripped).toBe(input);
    });

    test("round-trips correctly in EST", () => {
      const input = "2026-01-15T14:30";
      const utc = localToUtc(input, "America/New_York");
      const roundTripped = utcToLocalInput(utc, "America/New_York");
      expect(roundTripped).toBe(input);
    });

    test("round-trips correctly in JST", () => {
      const input = "2026-06-15T14:30";
      const utc = localToUtc(input, "Asia/Tokyo");
      const roundTripped = utcToLocalInput(utc, "Asia/Tokyo");
      expect(roundTripped).toBe(input);
    });
  });
});
