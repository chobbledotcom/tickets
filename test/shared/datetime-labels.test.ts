import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatDatetimeLabel, formatDatetimeShort } from "#shared/dates.ts";
import { says } from "#test-utils/says.ts";
import { testWithSetting, useSetting } from "#test-utils/settings.ts";

describe("datetime labels", () => {
  useSetting({ timezone: "UTC" });

  describe("formatDatetimeLabel", () => {
    test("formats ISO datetime as human-readable string", () => {
      says(formatDatetimeLabel("2026-06-15T14:00:00.000Z"), "at 14:00");
    });

    test("pads single-digit hours and minutes", () => {
      says(formatDatetimeLabel("2026-01-05T09:05:00.000Z"), "at 09:05");
    });

    test("handles midnight", () => {
      says(formatDatetimeLabel("2026-03-01T00:00:00.000Z"), "at 00:00");
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
