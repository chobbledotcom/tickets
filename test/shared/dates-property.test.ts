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

/** The clock time (hours, minutes, seconds, ms) an ISO instant carries. */
const timeOfDay = (iso: string): string => iso.slice(10);

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
  test("keeps the clock time and lands on a real day of the target month", () => {
    fc.assert(
      fc.property(
        isoInstant,
        fc.integer({ max: 24, min: -24 }),
        (iso, months) => {
          if (months === 0) return;
          const shifted = addMonthsIso(iso, months);
          expect(timeOfDay(shifted)).toBe(timeOfDay(iso));
          const result = new Date(shifted);
          const monthLength = daysInMonth(
            result.getUTCFullYear(),
            result.getUTCMonth() + 1,
          );
          expect(result.getUTCDate()).toBeLessThanOrEqual(monthLength);
        },
      ),
      seedArgs,
    );
  });
});

describe("parseIsoDateParam properties", () => {
  test("is total on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (value) => {
        const parsed = new Date(`${value}T00:00:00Z`);
        const realDay =
          CALENDAR_DATE.test(value) &&
          parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
          parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
          parsed.getUTCDate() === Number(value.slice(8, 10));
        const result = parseIsoDateParam(value);
        expect(result).toBe(realDay ? value : null);
      }),
      seedArgs,
    );
  });
});
