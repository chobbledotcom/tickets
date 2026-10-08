/** The date parsing module's direct tests: the real-day rule, the branded
 *  parse, the stored fallback, and the UTC instant shape. The month rule's
 *  tests live in date.test.ts beside the month module. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type DateString,
  isIsoDate,
  isRealCalendarDay,
  isUtcInstantOfRealDay,
  parseDateString,
  parseDateStringOrThrow,
} from "#shared/validation/date-string.ts";

describe("isRealCalendarDay", () => {
  test("accepts a real calendar day", () => {
    expect(isRealCalendarDay("2026-06-14")).toBe(true);
    expect(isRealCalendarDay("2024-02-29")).toBe(true);
  });

  test("refuses a rollover date that is not a real day", () => {
    expect(isRealCalendarDay("2026-02-30")).toBe(false);
  });
});

describe("isIsoDate", () => {
  test("accepts a strict real date", () => {
    expect(isIsoDate("2026-06-14")).toBe(true);
  });

  test("refuses an unpadded or impossible date", () => {
    expect(isIsoDate("2026-6-14")).toBe(false);
    expect(isIsoDate("2026-02-30")).toBe(false);
  });
});

describe("parseDateString", () => {
  test("trims surrounding whitespace and returns the clean date", () => {
    expect(parseDateString("  2027-06-01  ")).toBe("2027-06-01");
    expect(parseDateString("2027-06-01")).toBe("2027-06-01");
  });

  test("refuses an unpadded date the format check rejects", () => {
    expect(parseDateString("2027-6-1")).toBeNull();
  });

  test("refuses a rollover impossibility the real-day check rejects", () => {
    expect(parseDateString("2027-02-30")).toBeNull();
  });

  test("refuses a datetime string offered to a date field", () => {
    expect(parseDateString("2027-06-01T00:00")).toBeNull();
  });

  test("refuses wording no comparison could order", () => {
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

describe("parseDateStringOrThrow", () => {
  test("returns the parsed date and names the source on a refusal", () => {
    expect(parseDateStringOrThrow("2027-06-01", "the test date")).toBe(
      "2027-06-01",
    );
    expect(() => parseDateStringOrThrow("soon", "the test date")).toThrow(
      "the test date does not hold a usable date: soon",
    );
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

  test("refuses a fractional second without the seconds", () => {
    expect(isUtcInstantOfRealDay("2026-06-15T10:00.1Z")).toBe(false);
  });

  test("refuses a surplus segment after the zone designator", () => {
    expect(isUtcInstantOfRealDay("2026-06-15T10:00:00ZTextra")).toBe(false);
  });

  test("refuses a sub-millisecond UTC instant", () => {
    expect(isUtcInstantOfRealDay("2026-06-15T10:00:00.123456Z")).toBe(false);
    expect(parseDateString("2026-06-15T10:00:00.123456Z")).toBe(null);
  });
});
