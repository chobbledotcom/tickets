/**
 * The pure date helpers of the public order suites: the ring arithmetic
 * nextWeekday uses to find the next date with a given weekday.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import { nextWeekday } from "./helpers.ts";

describe("nextWeekday", () => {
  // 2026-03-02 is a Monday.
  test("walks forward to the requested weekday", () => {
    expect(
      nextWeekday(parseDateStringOrThrow("2026-03-02", "fixture"), "Wednesday"),
    ).toBe("2026-03-04");
  });

  test("rolls a full week forward when the day matches", () => {
    expect(
      nextWeekday(parseDateStringOrThrow("2026-03-02", "fixture"), "Monday"),
    ).toBe("2026-03-09");
  });
});
