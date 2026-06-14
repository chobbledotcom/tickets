import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  applyNameReplacement,
  buildDuplicatePreview,
  computeDayOffset,
  formatIsoForPreview,
  shiftUtcIsoByDays,
} from "#shared/bulk-replace.ts";

describe("bulk-replace", () => {
  describe("applyNameReplacement", () => {
    test("replaces every occurrence of the find substring", () => {
      expect(
        applyNameReplacement("Spring Workshop Spring", "Spring", "Autumn"),
      ).toBe("Autumn Workshop Autumn");
    });

    test("returns the original name when find is empty", () => {
      expect(applyNameReplacement("Spring 2026", "", "anything")).toBe(
        "Spring 2026",
      );
    });

    test("leaves the name unchanged when find is absent", () => {
      expect(applyNameReplacement("Summer 2026", "Spring", "Autumn")).toBe(
        "Summer 2026",
      );
    });

    test("allows deleting the find substring by using empty replace", () => {
      expect(applyNameReplacement("Spring Workshop", "Spring ", "")).toBe(
        "Workshop",
      );
    });
  });

  describe("computeDayOffset", () => {
    test("returns the day count between two dates (replace - find)", () => {
      expect(computeDayOffset("2026-04-16", "2026-04-23")).toBe(7);
    });

    test("returns a negative offset when replace is earlier", () => {
      expect(computeDayOffset("2026-04-23", "2026-04-16")).toBe(-7);
    });

    test("spans months and years correctly", () => {
      expect(computeDayOffset("2026-12-31", "2027-01-02")).toBe(2);
    });

    test("returns 0 when either date is empty", () => {
      expect(computeDayOffset("", "2026-04-23")).toBe(0);
      expect(computeDayOffset("2026-04-16", "")).toBe(0);
    });
  });

  describe("shiftUtcIsoByDays", () => {
    test("adds days to a UTC ISO datetime", () => {
      expect(shiftUtcIsoByDays("2026-04-16T09:00:00.000Z", 7)).toBe(
        "2026-04-23T09:00:00.000Z",
      );
    });

    test("accepts negative offsets", () => {
      expect(shiftUtcIsoByDays("2026-04-16T09:00:00.000Z", -1)).toBe(
        "2026-04-15T09:00:00.000Z",
      );
    });

    test("returns the input unchanged for zero-day offsets", () => {
      const iso = "2026-04-16T09:00:00.000Z";
      expect(shiftUtcIsoByDays(iso, 0)).toBe(iso);
    });

    test("returns empty string for empty input", () => {
      expect(shiftUtcIsoByDays("", 5)).toBe("");
    });
  });

  describe("buildDuplicatePreview", () => {
    const listings = [
      { date: "2026-04-16T09:00:00.000Z", id: 1, name: "Spring Workshop" },
      { date: "2026-04-18T12:00:00.000Z", id: 2, name: "Spring Picnic" },
    ];

    test("applies both name and date replacements across all listings", () => {
      const rows = buildDuplicatePreview(listings, {
        dateFind: "2026-04-16",
        dateReplace: "2026-04-23",
        nameFind: "Spring",
        nameReplace: "Autumn",
      });
      expect(rows).toEqual([
        {
          id: 1,
          newDate: "2026-04-23T09:00:00.000Z",
          newName: "Autumn Workshop",
          originalDate: "2026-04-16T09:00:00.000Z",
          originalName: "Spring Workshop",
        },
        {
          id: 2,
          newDate: "2026-04-25T12:00:00.000Z",
          newName: "Autumn Picnic",
          originalDate: "2026-04-18T12:00:00.000Z",
          originalName: "Spring Picnic",
        },
      ]);
    });

    test("echoes the original values when no replacements are set", () => {
      const rows = buildDuplicatePreview(listings, {
        dateFind: "",
        dateReplace: "",
        nameFind: "",
        nameReplace: "",
      });
      expect(rows[0]!.newName).toBe("Spring Workshop");
      expect(rows[0]!.newDate).toBe("2026-04-16T09:00:00.000Z");
    });

    test("returns an empty array when the group has no listings", () => {
      expect(
        buildDuplicatePreview([], {
          dateFind: "2026-04-16",
          dateReplace: "2026-04-23",
          nameFind: "Spring",
          nameReplace: "Autumn",
        }),
      ).toEqual([]);
    });
  });

  describe("formatIsoForPreview", () => {
    test("formats a UTC ISO string in the configured timezone", () => {
      expect(
        formatIsoForPreview("2026-06-15T13:00:00.000Z", "Europe/London"),
      ).toBe("2026-06-15 14:00");
    });

    test("returns empty string for empty input", () => {
      expect(formatIsoForPreview("", "Europe/London")).toBe("");
    });
  });
});
