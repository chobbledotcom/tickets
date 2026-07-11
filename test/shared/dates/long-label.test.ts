import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatDateLongLabel } from "#shared/dates.ts";
import { testWithSetting } from "#test-utils/settings.ts";

describe("formatDateLongLabel", () => {
  test("formats a UTC datetime as a date-only label, dropping the time", () => {
    expect(formatDateLongLabel("2026-06-15T14:30:00.000Z")).toBe(
      "Monday 15 June 2026",
    );
  });

  testWithSetting(
    "uses the configured timezone when the instant crosses midnight",
    { timezone: "Europe/London" },
    () => {
      // 23:30 UTC on June 15 = 00:30 BST on June 16 → the next day's label.
      expect(formatDateLongLabel("2026-06-15T23:30:00.000Z")).toBe(
        "Tuesday 16 June 2026",
      );
    },
  );

  test("returns an empty string for an empty input", () => {
    expect(formatDateLongLabel("")).toBe("");
  });

  test("returns an empty string for an invalid input", () => {
    expect(formatDateLongLabel("not-a-date")).toBe("");
  });
});
