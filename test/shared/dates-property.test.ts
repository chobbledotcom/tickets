// Property tests for the pure date-string math: addDays and dateRange over
// generated real calendar dates, addMonthsIso's time-of-day and clamping
// guarantees, and parseIsoDateParam's totality. fast-check runs each property
// with a fixed seed and run count, so every run generates the same cases.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import {
  addDays,
  addMonthsIso,
  dateRange,
  parseIsoDateParam,
} from "#shared/dates.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";

const seedArgs = { numRuns: 100, seed: 20261018 } as const;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A generator of [year, month, day] triples over real months, with the day
 * capped at 28 so every triple is a valid date. */
const ymdParts = (): fc.Arbitrary<[number, number, number]> =>
  fc.tuple(
    fc.integer({ max: 2100, min: 2000 }),
    fc.integer({ max: 12, min: 1 }),
    fc.integer({ max: 28, min: 1 }),
  );

/** The YYYY-MM-DD string a triple names. */
const isoDay = ([year, month, day]: readonly [
  number,
  number,
  number,
]): string =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** A generator of real calendar dates between 2000 and 2100, branded through
 * the same parse boundary production callers use. */
const calendarDate = ymdParts().map((parts) =>
  parseDateStringOrThrow(isoDay(parts), "a generated calendar date"),
);

/** A generator of real full ISO instants between 2000 and 2100, with the day
 * capped at 28 so every generated instant is valid. */
const isoInstant = ymdParts().chain(([year, month, day]) =>
  fc
    .tuple(
      fc.integer({ max: 23, min: 0 }),
      fc.integer({ max: 59, min: 0 }),
      fc.integer({ max: 59, min: 0 }),
    )
    .map(([hour, minute, second]) =>
      new Date(
        Date.UTC(year, month - 1, day, hour, minute, second),
      ).toISOString(),
    ),
);

/** The days a Gregorian month holds. */
const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

describe("addDays properties", () => {
  test("is invertible: adding then subtracting the same days returns the date", () => {
    fc.assert(
      fc.property(
        calendarDate,
        fc.integer({ max: 1000, min: -1000 }),
        (date, days) => {
          expect(addDays(addDays(date, days), -days)).toBe(date);
        },
      ),
      seedArgs,
    );
  });

  test("always returns a real calendar date", () => {
    fc.assert(
      fc.property(
        calendarDate,
        fc.integer({ max: 1000, min: -1000 }),
        (date, days) => {
          const shifted = addDays(date, days);
          expect(shifted).toMatch(CALENDAR_DATE);
          const parsed = new Date(`${shifted}T00:00:00Z`);
          expect(parsed.getUTCFullYear()).toBe(Number(shifted.slice(0, 4)));
          expect(parsed.getUTCMonth() + 1).toBe(Number(shifted.slice(5, 7)));
          expect(parsed.getUTCDate()).toBe(Number(shifted.slice(8, 10)));
        },
      ),
      seedArgs,
    );
  });
});

describe("dateRange properties", () => {
  test("returns start..end inclusive, and nothing when start is past end", () => {
    fc.assert(
      fc.property(
        calendarDate,
        fc.integer({ max: 60, min: -30 }),
        (start, span) => {
          const end = addDays(start, span);
          const range = dateRange(start, end);
          if (span < 0) {
            expect(range).toEqual([]);
          } else {
            expect(range.length).toBe(span + 1);
            expect(range[0]).toBe(start);
            expect(range.at(-1)).toBe(end);
          }
        },
      ),
      seedArgs,
    );
  });
});

describe("addMonthsIso properties", () => {
  test("lands on the expected clamped day, with the clock time kept", () => {
    fc.assert(
      fc.property(
        isoInstant,
        fc.integer({ max: 24, min: -24 }),
        (iso, months) => {
          if (months === 0) return;
          const source = new Date(iso);
          // The target month arithmetic runs through month index 0..11 with
          // the year carrying the overflow, so January plus one month is
          // February of the same year and December plus one is the next
          // January.
          const targetMonthIndex = source.getUTCMonth() + months;
          const targetYear =
            source.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
          const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
          const expectedDay = Math.min(
            source.getUTCDate(),
            daysInMonth(targetYear, targetMonth + 1),
          );
          const expected = new Date(
            Date.UTC(
              targetYear,
              targetMonth,
              expectedDay,
              source.getUTCHours(),
              source.getUTCMinutes(),
              source.getUTCSeconds(),
              source.getUTCMilliseconds(),
            ),
          ).toISOString();
          expect(addMonthsIso(iso, months)).toBe(expected);
        },
      ),
      seedArgs,
    );
  });

  test("clamps a month-end day onto the target month's last day", () => {
    // A source day the target month cannot hold (31 into a 30- or 28-day
    // month) must land on that month's last day, not spill into it, in both
    // shift directions.
    fc.assert(
      fc.property(
        fc.integer({ max: 2100, min: 2001 }),
        fc.integer({ max: 11, min: 0 }),
        fc.integer({ max: 24, min: -24 }),
        (year, monthIndex, months) => {
          if (months === 0) return;
          const sourceDay = 31;
          if (daysInMonth(year, monthIndex + 1) < 31) return;
          const source = new Date(Date.UTC(year, monthIndex, sourceDay));
          const shifted = addMonthsIso(source.toISOString(), months);
          const targetMonthIndex = monthIndex + months;
          const targetYear = year + Math.floor(targetMonthIndex / 12);
          const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
          expect(new Date(shifted).getUTCDate()).toBe(
            Math.min(31, daysInMonth(targetYear, targetMonth + 1)),
          );
        },
      ),
      seedArgs,
    );
  });
});

describe("parseIsoDateParam properties", () => {
  test("is total on arbitrary input", () => {
    fc.assert(
      fc.property(
        // A plain string almost never forms a date. Mix in date-shaped
        // strings with impossible months and days, so the oracle below sees
        // both outcomes.
        fc.oneof(
          fc.string({ maxLength: 40 }),
          fc.stringMatching(/^\d{4}-(0\d|1[0-3])-([0-3]\d)$/),
        ),
        (value) => {
          const parsed = new Date(`${value}T00:00:00Z`);
          const realDay =
            CALENDAR_DATE.test(value) &&
            parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
            parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
            parsed.getUTCDate() === Number(value.slice(8, 10));
          const result = parseIsoDateParam(value);
          expect(result).toBe(realDay ? value : null);
        },
      ),
      seedArgs,
    );
  });

  test("returns real calendar dates and rejects same-shape fakes", () => {
    fc.assert(
      fc.property(
        calendarDate,
        fc.integer({ max: 12, min: 1 }),
        (date, fakeDay) => {
          expect(parseIsoDateParam(date)).toBe(date);
          // The same shape with an impossible day: always rejected, even
          // though the string reads like a date.
          const fake = `${date.slice(0, 8)}${String(29 + (fakeDay % 3)).padStart(2, "0")}`;
          const parsed = new Date(`${fake}T00:00:00Z`);
          const fakeIsReal = parsed.getUTCDate() === Number(fake.slice(8, 10));
          expect(parseIsoDateParam(fake)).toBe(fakeIsReal ? fake : null);
        },
      ),
      seedArgs,
    );
  });
});
