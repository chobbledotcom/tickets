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
import { addDays } from "#shared/dates.ts";
import {
  dayStartEpochMs,
  epochMsToTzDate,
  formatDatetimeShortInTz,
  utcToLocalInput,
} from "#shared/timezone.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";

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
  "America/Santiago",
] as const;

/** The 2026 DST transition days of those zones: a generated day set alone
 * can land on none of them. */
const TRANSITION_DAYS = [
  "2026-03-08",
  "2026-03-29",
  "2026-04-04",
  "2026-04-05",
  "2026-09-06",
  "2026-09-27",
  "2026-10-04",
  "2026-10-25",
  "2026-11-01",
] as const;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** A generator of real calendar YYYY-MM-DD days between 2025 and 2027, with
 * the day capped at 28 so every generated triple is a valid date, plus the
 * zones' explicit DST transition days. */
const anyDay = fc.oneof(
  fc
    .tuple(
      fc.integer({ max: 2027, min: 2025 }),
      fc.integer({ max: 12, min: 1 }),
      fc.integer({ max: 28, min: 1 }),
    )
    .map(
      ([year, month, day]) =>
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    ),
  fc.constantFrom(...TRANSITION_DAYS),
);

/** A generator of epoch milliseconds in a fixed window (2025-2027), so the
 * instants are deterministic and carry DST transitions. */
const epochMs = fc.integer({
  max: Date.UTC(2027, 0, 1),
  min: Date.UTC(2025, 0, 1),
});

/** Assert both day boundaries for one zone/day pair: the day start labels
 * back as the day, and the millisecond before it reads as the previous day,
 * so the start really is the day's first instant, not noon or any later
 * moment of it. */
const expectDayBoundaries = (tz: string, day: string): void => {
  const localDay = parseDateStringOrThrow(day, "a local day");
  const start = dayStartEpochMs(localDay, tz);
  expect(epochMsToTzDate(start, tz)).toBe(localDay);
  expect(epochMsToTzDate(start - 1, tz)).toBe(addDays(localDay, -1));
};

describe("timezone conversion properties", () => {
  test("a day start in any supported zone labels back as that day", () => {
    fc.assert(
      fc.property(anyDay, fc.constantFrom(...ZONES), (day, tz) => {
        expectDayBoundaries(tz, day);
      }),
      seedArgs,
    );
  });

  test("each zone's own DST transition days hold both day boundaries", () => {
    // Sampled day/zone pairs can miss the date a zone actually transitions
    // on, so every zone's 2026 spring-forward and fall-back days are named
    // here with their own zone.
    const transitions: [string, string][] = [
      ["Europe/London", "2026-03-29"],
      ["Europe/London", "2026-10-25"],
      ["America/New_York", "2026-03-08"],
      ["America/New_York", "2026-11-01"],
      ["Australia/Lord_Howe", "2026-04-05"],
      ["Australia/Lord_Howe", "2026-10-04"],
      ["Pacific/Chatham", "2026-04-05"],
      ["Pacific/Chatham", "2026-09-27"],
      ["America/St_Johns", "2026-03-08"],
      ["America/St_Johns", "2026-11-01"],
      ["America/Santiago", "2026-04-04"],
      ["America/Santiago", "2026-09-06"],
    ];
    for (const [tz, day] of transitions) {
      expectDayBoundaries(tz, day);
    }
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
