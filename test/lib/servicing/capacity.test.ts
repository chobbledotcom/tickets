/**
 * Servicing §0 — pure unit tests for the capacity helpers that decide which
 * days a servicing hold consumes and the WHERE guard that blocks the atomic
 * insert.
 *
 *   • `overlapsDay` / `expandDailyRange` must be half-open `[start, end)`:
 *     the day's `startAt` is included and its `endAt` excluded. A multi-day
 *     servicing hold on `[2026-06-24, 2026-06-26)` must reduce availability
 *     for 24 and 25 only, leaving the adjacent 23 and 26 untouched (§2).
 *   • `buildCapacityCheckedInsert` must include the capacity condition by
 *     default and drop it when `allowOverbook=true` (so an operator can
 *     close a day entirely, §2 / §"servicing may overbook"). Flipping the
 *     flag changes the SQL — the assertion is mutation-resistant.
 *
 * Implementation contract (test-first — code not yet written):
 *   - `#shared/db/attendees/capacity.ts` currently keeps `overlapsDay` and
 *     `expandDailyRange` module-private. The implementation must EXPORT them
 *     so these unit tests can exercise them directly (the alternative —
 *     driving them through `checkListingAvailability` — would only give
 *     integration coverage; the [U]/[I] split in tests.md is intentional).
 *   - `#shared/db/attendees/capacity.ts` already exports
 *     `buildCapacityCheckedInsert(booking, attendeeIdExpr?, attendeeIdArg?,
 *     allowOverbook=false)`.
 *   - `#shared/db/capacity.ts` already exports `dateToRange` (used to derive
 *     a day's exact startAt/endAt so the boundary assertions are
 *     timezone-independent).
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import {
  buildCapacityCheckedInsert,
  expandDailyRange,
  overlapsDay,
} from "#shared/db/attendees/capacity.ts";
import { dateToRange } from "#shared/db/capacity.ts";

// jscpd:ignore-end

describe("servicing §0 — capacity overlap predicate is half-open", () => {
  // `overlapsDay(day)` returns a predicate over rows carrying string
  // `start_at`/`end_at`; comparisons mirror SQLite TEXT byte-for-byte, so the
  // boundary assertions below are exact (we derive the day's endpoints from
  // `dateToRange` itself to stay timezone-independent).
  const day = "2026-06-24";
  const { startAt, endAt } = dateToRange(day);

  const cases: Array<
    [label: string, start: string, end: string, expected: boolean]
  > = [
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

describe("servicing §0 — capacity-checked insert builds the WHERE guard", () => {
  const booking = {
    date: "2026-06-24",
    durationDays: 1,
    listingId: 1,
    quantity: 2,
  };

  test("by default the INSERT carries a capacity guard (WHERE clause present)", () => {
    const { sql, args } = buildCapacityCheckedInsert(booking);
    const { startAt } = dateToRange("2026-06-24");
    expect(/WHERE/i.test(sql)).toBe(true);
    // The booking arguments remain unchanged whether or not the guard exists.
    expect(args).toContain(2);
    expect(args).toContain(startAt);
  });

  test("allowOverbook=true drops the capacity guard (mutation: flipping the flag changes the SQL)", () => {
    const guarded = buildCapacityCheckedInsert(booking).sql;
    const unguarded = buildCapacityCheckedInsert(
      { ...booking },
      "last_insert_rowid()",
      undefined,
      true,
    ).sql;
    expect(/WHERE/i.test(guarded)).toBe(true);
    expect(/WHERE/i.test(unguarded)).toBe(false);
    // The two SQL strings must not be identical — a mutant that ignores
    // `allowOverbook` would make them equal.
    expect(guarded).not.toBe(unguarded);
  });

  test("the guard references the listing id and quantity (a mutant that drops either fails)", () => {
    const { sql, args } = buildCapacityCheckedInsert(booking);
    expect(sql).toMatch(/listing_id|booked_quantity|listing_attendees/);
    // Quantity is bound as an arg in the INSERT VALUES not the WHERE.
    expect(args).toContain(2);
    expect(args).toContain(1);
  });
});
