import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  DEFAULT_TIMEZONE,
  dayStartEpochMs,
  epochMsToTzDate,
  formatDatetimeInTz,
  formatDatetimeShortInTz,
  isValidDatetime,
  isValidTimezone,
  localToUtc,
  todayInTz,
  utcToLocalInput,
} from "#shared/timezone.ts";
import { isIsoDate } from "#shared/validation/date.ts";

describe("timezone", () => {
  describe("DEFAULT_TIMEZONE", () => {
    test("is Europe/London", () => {
      expect(DEFAULT_TIMEZONE).toBe("Europe/London");
    });
  });

  describe("todayInTz", () => {
    test("returns a YYYY-MM-DD string", () => {
      const result = todayInTz("Europe/London");
      // Reuse the production calendar-date guard rather than a hand-rolled
      // regex: it enforces the same YYYY-MM-DD shape and additionally that the
      // value is a real calendar day, which today's date always is.
      expect(isIsoDate(result)).toBe(true);
    });

    test("returns same date for same timezone", () => {
      const a = todayInTz("UTC");
      const b = todayInTz("UTC");
      expect(a).toBe(b);
    });

    test("is controllable under FakeTime (reads the fakeable clock)", () => {
      // Temporal.Now bypasses FakeTime; todayInTz must derive "today" from
      // Date.now() so date-dependent code stays deterministic in frozen-time
      // tests (booking windows, holiday cutoffs, calendar/delivery pages).
      const time = new FakeTime(new Date("2030-01-15T12:00:00Z"));
      try {
        expect(todayInTz("Europe/London")).toBe("2030-01-15");
      } finally {
        time.restore();
      }
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

    test("rejects a datetime carrying a numeric offset", () => {
      // Input must be naive: an offset would otherwise be silently discarded
      // and the wall-clock time reinterpreted in the target timezone, storing
      // a different instant than the string implies.
      expect(() =>
        localToUtc("2026-06-15T14:30+09:00", "Europe/London"),
      ).toThrow("Invalid datetime");
    });

    test("rejects a datetime carrying a bracketed IANA zone", () => {
      expect(() =>
        localToUtc("2026-06-15T14:30[Asia/Tokyo]", "Europe/London"),
      ).toThrow("Invalid datetime");
    });

    test("rejects a datetime carrying a UTC designator", () => {
      expect(() => localToUtc("2026-06-15T14:30Z", "Europe/London")).toThrow(
        "Invalid datetime",
      );
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
      const result = formatDatetimeInTz(
        "2026-01-15T14:30:00.000Z",
        "Europe/London",
      );
      expect(result).toContain("Thursday 15 January 2026 at 14:30");
      expect(result).toContain("GMT");
    });

    test("formats UTC datetime in London summer time (BST)", () => {
      // 13:30 UTC = 14:30 BST
      const result = formatDatetimeInTz(
        "2026-06-15T13:30:00.000Z",
        "Europe/London",
      );
      expect(result).toContain("Monday 15 June 2026 at 14:30");
    });

    test("formats UTC datetime in Tokyo", () => {
      // 05:30 UTC = 14:30 JST
      const result = formatDatetimeInTz(
        "2026-06-15T05:30:00.000Z",
        "Asia/Tokyo",
      );
      expect(result).toContain("Monday 15 June 2026 at 14:30");
    });

    test("pads single-digit hours and minutes", () => {
      const result = formatDatetimeInTz("2026-01-05T09:05:00.000Z", "UTC");
      expect(result).toContain("Monday 5 January 2026 at 09:05");
      expect(result).toContain("UTC");
    });
  });

  describe("formatDatetimeShortInTz", () => {
    test("formats UTC datetime in London summer time (BST)", () => {
      // 13:00 UTC on 7 April 2026 = 14:00 BST (BST starts 29 March 2026)
      const result = formatDatetimeShortInTz(
        "2026-04-07T13:00:00.000Z",
        "Europe/London",
      );
      expect(result).toBe("2026-04-07 14:00");
    });

    test("formats UTC datetime in London winter time (GMT)", () => {
      const result = formatDatetimeShortInTz(
        "2026-01-15T09:05:00.000Z",
        "Europe/London",
      );
      expect(result).toBe("2026-01-15 09:05");
    });

    test("formats UTC datetime in Asia/Tokyo (UTC+9)", () => {
      const result = formatDatetimeShortInTz(
        "2026-06-15T05:30:00.000Z",
        "Asia/Tokyo",
      );
      expect(result).toBe("2026-06-15 14:30");
    });

    test("pads single-digit month, day, hour and minute", () => {
      const result = formatDatetimeShortInTz("2026-01-05T09:05:00.000Z", "UTC");
      expect(result).toBe("2026-01-05 09:05");
    });

    test("normalises midnight rendered as 24:00", () => {
      // Some sv-SE implementations render midnight as "24:00"; we normalise.
      const result = formatDatetimeShortInTz("2026-06-15T00:00:00.000Z", "UTC");
      expect(result).toBe("2026-06-15 00:00");
    });
  });

  describe("utcToLocalInput", () => {
    test("converts UTC to datetime-local in UTC", () => {
      const result = utcToLocalInput("2026-06-15T14:30:00.000Z", "UTC");
      expect(result).toBe("2026-06-15T14:30");
    });

    test("converts UTC to London summer time", () => {
      // 13:30 UTC = 14:30 BST
      const result = utcToLocalInput(
        "2026-06-15T13:30:00.000Z",
        "Europe/London",
      );
      expect(result).toBe("2026-06-15T14:30");
    });

    test("converts UTC to London winter time", () => {
      // 14:30 UTC = 14:30 GMT
      const result = utcToLocalInput(
        "2026-01-15T14:30:00.000Z",
        "Europe/London",
      );
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

    test("rejects an impossible calendar date", () => {
      // overflow: "reject" must not clamp 2026-02-30 to a real day.
      expect(isValidDatetime("2026-02-30T00:00")).toBe(false);
    });

    test("rejects a datetime carrying a numeric offset", () => {
      expect(isValidDatetime("2026-06-15T14:30+09:00")).toBe(false);
    });

    test("rejects a datetime carrying a bracketed IANA zone", () => {
      expect(isValidDatetime("2026-06-15T14:30[Asia/Tokyo]")).toBe(false);
    });

    test("rejects a :60 leap second instead of clamping it to :59", () => {
      // Temporal clamps :60 to :59 even under overflow:"reject"; the naive
      // shape guard rejects it so a crafted value never stores a shifted time.
      expect(isValidDatetime("2026-06-15T14:30:60")).toBe(false);
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

  describe("dayStartEpochMs", () => {
    test("is local midnight, so a non-UTC zone is offset from UTC midnight", () => {
      // Tokyo is UTC+9 with no DST: local midnight is 15:00 the previous UTC day.
      expect(dayStartEpochMs("2026-06-15", "Asia/Tokyo")).toBe(
        new Date("2026-06-14T15:00:00.000Z").getTime(),
      );
    });

    test("in UTC it is exactly the day's UTC midnight", () => {
      expect(dayStartEpochMs("2026-06-15", "UTC")).toBe(
        new Date("2026-06-15T00:00:00.000Z").getTime(),
      );
    });
  });

  describe("epochMsToTzDate", () => {
    test("is the inverse of dayStartEpochMs for that day's start", () => {
      const ms = dayStartEpochMs("2026-06-15", "Asia/Tokyo");
      expect(epochMsToTzDate(ms, "Asia/Tokyo")).toBe("2026-06-15");
    });

    test("buckets an instant onto its LOCAL day, not the UTC day", () => {
      // 22:30 UTC on 14 June is already 07:30 on 15 June in Tokyo.
      expect(
        epochMsToTzDate(Date.parse("2026-06-14T22:30:00Z"), "Asia/Tokyo"),
      ).toBe("2026-06-15");
    });
  });
});
