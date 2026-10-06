import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DateString,
  isIsoDate,
  isIsoMonth,
  isRealCalendarDay,
  isUtcInstantOfRealDay,
  parseDateString,
} from "#shared/validation/date.ts";

describe("isRealCalendarDay", () => {
  test("accepts a real calendar date including the leap day", () => {
    expect(isRealCalendarDay("2026-12-25")).toBe(true);
    expect(isRealCalendarDay("2028-02-29")).toBe(true);
  });

  test("rejects a rollover impossibility Date would normalise", () => {
    expect(isRealCalendarDay("2026-02-30")).toBe(false);
    expect(isRealCalendarDay("2027-02-29")).toBe(false);
  });

  test("returns false rather than throwing for an unparseable value", () => {
    // Month 99 / day 99 are shape-valid but make Date NaN; the guard must
    // answer false here instead of calling toISOString() on an Invalid Date.
    expect(isRealCalendarDay("2026-99-99")).toBe(false);
    expect(isRealCalendarDay("not-a-date")).toBe(false);
  });
});

describe("isIsoDate", () => {
  test("accepts real calendar dates including the leap day", () => {
    expect(isIsoDate("2026-12-25")).toBe(true);
    expect(isIsoDate("2026-01-01")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true); // 2028 is a leap year
  });

  test("rejects wrong formats", () => {
    expect(isIsoDate("12/25/2026")).toBe(false);
    expect(isIsoDate("2026/01/15")).toBe(false);
    expect(isIsoDate("2026-12")).toBe(false);
    expect(isIsoDate("2026-1-1")).toBe(false); // single-digit month/day
    expect(isIsoDate("not-a-date")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  test("rejects out-of-range months and days", () => {
    expect(isIsoDate("2026-00-01")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-01-00")).toBe(false);
    expect(isIsoDate("2026-01-32")).toBe(false);
  });

  test("rejects well-formatted but impossible calendar dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(false); // February never has 30 days
    expect(isIsoDate("2027-02-29")).toBe(false); // 2027 is not a leap year
    expect(isIsoDate("2026-06-31")).toBe(false); // June has only 30 days
  });
});

describe("isIsoMonth", () => {
  test("accepts every real month of a year", () => {
    expect(isIsoMonth("2026-01")).toBe(true);
    expect(isIsoMonth("2026-09")).toBe(true);
    expect(isIsoMonth("2026-10")).toBe(true);
    expect(isIsoMonth("2026-12")).toBe(true);
  });

  test("rejects wrong formats", () => {
    expect(isIsoMonth("2026-1")).toBe(false); // single-digit month
    expect(isIsoMonth("2026-01-01")).toBe(false); // a full date is not a month
    expect(isIsoMonth("01-2026")).toBe(false);
    expect(isIsoMonth("")).toBe(false);
  });

  test("rejects out-of-range months a bare digit pattern would accept", () => {
    expect(isIsoMonth("2026-00")).toBe(false);
    expect(isIsoMonth("2026-13")).toBe(false);
    expect(isIsoMonth("2026-99")).toBe(false);
  });
});

describe("parseDateString", () => {
  test("trims surrounding whitespace and returns the clean date", () => {
    expect(parseDateString("  2027-06-01  ")).toBe("2027-06-01");
    expect(parseDateString("2027-06-01")).toBe("2027-06-01");
  });

  test("refuses an unpadded date the format check rejects", () => {
    // Was stored by the holiday JSON API before the shared parser existed.
    expect(parseDateString("2027-6-1")).toBeNull();
  });

  test("refuses a rollover impossibility the real-day check rejects", () => {
    // Was stored by the holiday JSON API before the shared parser existed.
    expect(parseDateString("2027-02-30")).toBeNull();
  });

  test("refuses a datetime string offered to a date field", () => {
    // Was stored by the holiday JSON API before the shared parser existed.
    expect(parseDateString("2027-06-01T00:00")).toBeNull();
  });

  test("refuses wording no comparison could order", () => {
    // Was stored by the holiday JSON API before the shared parser existed.
    expect(parseDateString("soon")).toBeNull();
  });

  test("refuses blank input", () => {
    expect(parseDateString("")).toBeNull();
    expect(parseDateString("   ")).toBeNull();
  });

  test("the branded type flows into date helpers, a raw string does not", () => {
    const cleaned = parseDateString("2027-06-01");
    if (!cleaned) throw new Error("the clean date must parse");
    // The compile-level proof: a helper that takes the brand refuses a raw
    // string, so a caller that skips the cleanup cannot type-check.
    const takesBrand = (value: DateString): string => value;
    // @ts-expect-error - a raw string is not a cleaned DateString
    takesBrand("2027-06-01");
    expect(takesBrand(cleaned)).toBe("2027-06-01");
  });
});

describe("isUtcInstantOfRealDay", () => {
  test("accepts a UTC instant of a real calendar day", () => {
    expect(isUtcInstantOfRealDay("2026-06-14T23:59:00Z")).toBe(true);
    expect(isUtcInstantOfRealDay("2026-01-02T00:00:00.000Z")).toBe(true);
  });

  test("refuses a date half that is not a real calendar day", () => {
    expect(isUtcInstantOfRealDay("2026-6-14T23:59:00Z")).toBe(false);
    expect(isUtcInstantOfRealDay("2026-02-30T10:00:00Z")).toBe(false);
    expect(isUtcInstantOfRealDay("soon")).toBe(false);
  });

  test("refuses a value with no zone designator", () => {
    expect(isUtcInstantOfRealDay("2026-06-15T10:00:00")).toBe(false);
    expect(isUtcInstantOfRealDay("2026-06-15")).toBe(false);
  });

  test("refuses clock values outside their ranges", () => {
    expect(isUtcInstantOfRealDay("2026-06-15T99:99:99Z")).toBe(false);
    expect(isUtcInstantOfRealDay("2026-06-15T24:00:00Z")).toBe(false);
    expect(isUtcInstantOfRealDay("2026-06-15T10:60:00Z")).toBe(false);
  });

  test("refuses a surplus segment after the zone designator", () => {
    expect(isUtcInstantOfRealDay("2026-06-15T10:00:00ZTextra")).toBe(false);
  });
});
