import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isIsoDate, isIsoMonth } from "#shared/validation/date.ts";

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
