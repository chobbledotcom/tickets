// Property tests for the timezone conversions: the documented day-boundary
// inverse pair (dayStartEpochMs then epochMsToTzDate returns the day), the
// two formatters' agreement, and formatter totality across a fixed set of
// IANA zones chosen to span half-hour offsets and both DST hemispheres.
// fast-check runs each property with a fixed seed and run count, so every run
// generates the same cases; the zones and instants are fixed, so the
// properties never read the wall clock or the ambient timezone.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import {
  dayStartEpochMs,
  epochMsToTzDate,
  formatDatetimeShortInTz,
  utcToLocalInput,
} from "#shared/timezone.ts";

const seedArgs = { numRuns: 100, seed: 20261018 } as const;

/** The zones the properties run against: UTC, the app's default, and IANA
 * zones with half-hour offsets, southern-hemisphere DST, and spring-forward
 * gaps at 00:00. */
const ZONES = [
  "UTC",
  "Europe/London",
  "America/New_York",
  "Asia/Kolkata",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "America/St_Johns",
] as const;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** A generator of real calendar YYYY-MM-DD days between 2025 and 2027, with
 * the day capped at 28 so every generated triple is a valid date. */
const calendarDay = fc
  .tuple(
    fc.integer({ max: 2027, min: 2025 }),
    fc.integer({ max: 12, min: 1 }),
    fc.integer({ max: 28, min: 1 }),
  )
  .map(
    ([year, month, day]) =>
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );

/** A generator of epoch milliseconds in a fixed window (2025-2027), so the
 * instants are deterministic and carry DST transitions. */
const epochMs = fc.integer({
  max: Date.UTC(2027, 0, 1),
  min: Date.UTC(2025, 0, 1),
});

describe("timezone conversion properties", () => {
  test("a day start in any supported zone labels back as that day", () => {
    fc.assert(
      fc.property(calendarDay, fc.constantFrom(...ZONES), (day, tz) => {
        expect(epochMsToTzDate(dayStartEpochMs(day, tz), tz)).toBe(day);
      }),
      seedArgs,
    );
  });

  test("the two local renderers agree on every instant and zone", () => {
    fc.assert(
      fc.property(epochMs, fc.constantFrom(...ZONES), (ms, tz) => {
        const iso = new Date(ms).toISOString();
        const input = utcToLocalInput(iso, tz);
        expect(input).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        expect(formatDatetimeShortInTz(iso, tz)).toBe(input.replace("T", " "));
      }),
      seedArgs,
    );
  });

  test("the short formatter is total and well-shaped everywhere", () => {
    fc.assert(
      fc.property(epochMs, fc.constantFrom(...ZONES), (ms, tz) => {
        const rendered = formatDatetimeShortInTz(
          new Date(ms).toISOString(),
          tz,
        );
        expect(rendered).toMatch(LOCAL_DATETIME);
        const [datePart, timePart] = rendered.split(" ");
        expect(datePart).toMatch(LOCAL_DATE);
        const hours = Number(timePart!.slice(0, 2));
        const minutes = Number(timePart!.slice(3, 5));
        expect(hours).toBeLessThanOrEqual(23);
        expect(minutes).toBeLessThanOrEqual(59);
      }),
      seedArgs,
    );
  });
});
