/**
 * Timezone conversion utilities built on the Temporal API.
 *
 * Temporal is imported from `temporal-polyfill` rather than used as a runtime
 * global: the deployed Bunny Edge bundle must run on whichever Deno the edge
 * happens to use, and Deno only exposes `Temporal` as a stable global from
 * 2.7+. Bundling the polyfill keeps behaviour identical across runtimes (and
 * in tests) instead of depending on an API the baseline runtime lacks.
 *
 * Provides simple string-in/string-out functions for the rest of the
 * codebase, with correct DST handling and explicit disambiguation.
 */

import { Temporal } from "temporal-polyfill";
import { formatIsoForPreview } from "#shared/bulk-replace.ts";

/** Default timezone when none is configured */
export const DEFAULT_TIMEZONE = "Europe/London";

/** Pad a number to two digits */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Convert epoch milliseconds to a ZonedDateTime in the given timezone */
const msToZoned = (ms: number, tz: string): Temporal.ZonedDateTime =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz);

/** Parse a UTC ISO string into a ZonedDateTime in the given timezone */
export const utcToZoned = (
  utcIso: string,
  tz: string,
): Temporal.ZonedDateTime => msToZoned(new Date(utcIso).getTime(), tz);

/**
 * Get today's date as YYYY-MM-DD in the given timezone.
 *
 * Reads the clock via `Date.now()` rather than `Temporal.Now` so the helper
 * stays controllable under `@std/testing/time`'s `FakeTime`, which patches
 * `Date`/timers but not `Temporal.Now`.
 */
export const todayInTz = (tz: string): string =>
  msToZoned(Date.now(), tz).toPlainDate().toString();

/**
 * The epoch-ms instant of the START of a calendar day (00:00 local time) in the
 * given timezone. Used to turn a `YYYY-MM-DD` filter bound into the integer
 * `occurred_at` bound the ledger queries compare against, so a day range is
 * interpreted in the operator's own timezone rather than UTC.
 */
export const dayStartEpochMs = (date: string, tz: string): number =>
  new Date(localToUtc(`${date}T00:00:00`, tz)).getTime();

/** The `YYYY-MM-DD` calendar day an epoch-ms instant falls on in `tz`. The
 *  inverse direction of {@link dayStartEpochMs}, for labelling a stored
 *  `occurred_at` as the local day it belongs to. */
export const epochMsToTzDate = (ms: number, tz: string): string =>
  msToZoned(ms, tz).toPlainDate().toString();

/**
 * Strict datetime-local shape: a calendar date optionally followed by a
 * wall-clock time. Deliberately excludes any UTC designator (`Z`), numeric
 * offset, or bracketed IANA zone, since the rest of the app interprets these
 * values in the configured timezone. `Temporal.PlainDateTime.from` handles
 * those suffixes inconsistently — it *rejects* a `Z` but silently *discards* a
 * numeric offset or bracketed zone (storing a different instant than written) —
 * so the regex rejects all three up front rather than relying on that.
 *
 * The time fields are range-constrained (`HH` 00–23, `MM`/`SS` 00–59) rather
 * than bare `\d{2}`: Temporal rejects an out-of-range hour/minute, but it
 * *clamps* a `:60` leap second to `:59` even under `overflow: "reject"`, which
 * would silently shift the stored time. The regex rejects it instead. Calendar
 * validity (real month/day) is still delegated to Temporal's `overflow`.
 */
const NAIVE_DATETIME =
  /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?)?$/;

/**
 * Parse a naive datetime-local value into a PlainDateTime, rejecting
 * offset/zone-bearing input up front, then delegating real calendar-validity
 * checks to Temporal (`overflow: "reject"` catches impossible dates like
 * 2026-02-30 rather than silently clamping them).
 */
const parseNaiveDateTime = (value: string): Temporal.PlainDateTime => {
  if (!NAIVE_DATETIME.test(value)) {
    throw new RangeError(`Non-naive datetime: ${value}`);
  }
  return Temporal.PlainDateTime.from(value, { overflow: "reject" });
};

/**
 * Convert a naive datetime-local value (YYYY-MM-DDTHH:MM) to a UTC ISO string,
 * interpreting the value as local time in the given timezone.
 *
 * Uses 'compatible' disambiguation: spring-forward gaps resolve to the later
 * (post-transition) time; fall-back overlaps resolve to the earlier occurrence.
 */
export const localToUtc = (naive: string, tz: string): string => {
  try {
    return parseNaiveDateTime(naive)
      .toZonedDateTime(tz, { disambiguation: "compatible" })
      .toInstant()
      .toString({ fractionalSecondDigits: 3 });
  } catch {
    throw new Error(`Invalid datetime: ${naive}`);
  }
};

/**
 * Format a UTC ISO datetime string for display in the given timezone.
 * Returns e.g. "Monday 15 June 2026 at 14:00 BST"
 */
export const formatDatetimeInTz = (utcIso: string, tz: string): string => {
  const { year, day, hour, minute } = utcToZoned(utcIso, tz);

  // Use Intl for weekday/month names and timezone abbreviation
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: tz,
    timeZoneName: "short",
    weekday: "long",
  }).formatToParts(new Date(utcIso));

  const get = (type: string): string =>
    parts.find((p) => p.type === type)!.value;

  return `${get("weekday")} ${day} ${get("month")} ${year} at ${pad2(hour)}:${pad2(
    minute,
  )} ${get("timeZoneName")}`;
};

/**
 * Compact format for table cells: "yyyy-MM-dd HH:mm" in the given timezone.
 * Delegates to the browser-compatible `formatIsoForPreview` helper so the
 * same formatting runs on the server and in the admin JS bundle.
 */
export const formatDatetimeShortInTz = (utcIso: string, tz: string): string =>
  formatIsoForPreview(utcIso, tz);

/**
 * Convert a UTC ISO datetime string to a datetime-local input value
 * (YYYY-MM-DDTHH:MM) in the given timezone.
 * Used for pre-populating form inputs with timezone-adjusted values.
 */
export const utcToLocalInput = (utcIso: string, tz: string): string => {
  const z = utcToZoned(utcIso, tz);
  return `${z.year}-${pad2(z.month)}-${pad2(z.day)}T${pad2(z.hour)}:${pad2(
    z.minute,
  )}`;
};

/**
 * Validate that a string is a valid IANA timezone identifier.
 */
export const isValidTimezone = (tz: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Check if a naive datetime-local string is a parseable datetime.
 * Does not interpret timezone — purely a format check.
 */
export const isValidDatetime = (value: string): boolean => {
  try {
    parseNaiveDateTime(value);
    return true;
  } catch {
    return false;
  }
};
