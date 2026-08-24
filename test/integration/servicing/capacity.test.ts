/** Pure tests for the half-open date ranges that servicing holds use. */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expandDailyRange, overlapsDay } from "#db/attendees/capacity/range.ts";
import { dateToRange } from "#db/capacity.ts";
import { addDays } from "#shared/dates.ts";

// jscpd:ignore-end

describe("servicing §0 — capacity overlap predicate is half-open", () => {
  // `overlapsDay(day)` returns a predicate over rows carrying string
  // `start_at`/`end_at`; comparisons mirror SQLite TEXT byte-for-byte, so the
  // boundary assertions below are exact (we derive the day's endpoints from
  // `dateToRange` itself to stay timezone-independent).
  const day = "2026-06-24";
  const { startAt, endAt } = dateToRange(day);

  const cases: [
    label: string,
    start: string,
    end: string,
    expected: boolean,
  ][] = [
    ["entire span is the day itself", startAt, endAt, true],
    [
      "a one-hour slice within the day",
      startAt,
      "2026-06-24T06:00:00.000Z",
      true,
    ],
    [
      "adjacent previous day, ends exactly at day start (boundary excluded)",
      `${addDays(day, -1)}T00:00:00Z`,
      startAt,
      false,
    ],
    [
      "adjacent next day, starts exactly at day end (boundary excluded)",
      endAt,
      `${addDays(day, 2)}T00:00:00Z`,
      false,
    ],
    [
      "exactly the millisecond before the day start",
      "2026-06-23T23:59:59.999Z",
      "2026-06-24T00:00:00Z",
      false,
    ],
    [
      "a longer span that fully encloses the day",
      "2026-06-20T00:00:00Z",
      "2026-06-30T00:00:00Z",
      true,
    ],
  ];

  for (const [label, start, end, expected] of cases) {
    test(`${label} ⇒ overlaps=${expected}`, () => {
      const pred = overlapsDay(day);
      const row = { end_at: end, quantity: 1, start_at: start };
      expect(pred(row)).toBe(expected);
    });
  }

  test("a multi-day hold overlaps each contained day but neither adjacent day", () => {
    // A two-night holding "room-cleaning" 2026-06-24 → 2026-06-26 (half-open)
    // overlaps 24 and 25 but NOT 23 or 26 — the §2 row-by-row invariant.
    const hold = {
      end_at: dateToRange("2026-06-25").endAt,
      quantity: 5,
      start_at: "2026-06-24T00:00:00Z",
    };
    expect(overlapsDay("2026-06-24")(hold)).toBe(true);
    expect(overlapsDay("2026-06-25")(hold)).toBe(true);
    expect(overlapsDay("2026-06-23")(hold)).toBe(false);
    expect(overlapsDay("2026-06-26")(hold)).toBe(false);
  });
});

describe("servicing §0 — expandDailyRange includes start and excludes start+duration", () => {
  test("single-day range (durationDays=1) yields just the start date", () => {
    expect(expandDailyRange("2026-06-24", 1)).toEqual(["2026-06-24"]);
  });

  test("a three-day range is start, start+1, start+2 (start is included, start+duration is the excluded bound)", () => {
    expect(expandDailyRange("2026-06-24", 3)).toEqual([
      "2026-06-24",
      "2026-06-25",
      "2026-06-26",
    ]);
  });

  test("adjacent ranges tile with no overlap and no gap (boundary cases)", () => {
    // `[24, 27)` and `[27, 28)` are back-to-back without overlap.
    const first = expandDailyRange("2026-06-24", 3);
    const second = expandDailyRange("2026-06-27", 1);
    const intersection = first.filter((d) => second.includes(d));
    expect(intersection).toEqual([]);
    expect(first.at(-1)).toBe("2026-06-26");
    expect(second[0]).toBe("2026-06-27");
  });
});
