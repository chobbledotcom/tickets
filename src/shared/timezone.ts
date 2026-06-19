/**
 * Timezone conversion utilities built on the standard Temporal API.
 *
 * Provides simple string-in/string-out functions for the rest of the
 * codebase, with correct DST handling and explicit disambiguation.
 */

import { formatIsoForPreview } from "#shared/bulk-replace.ts";

/** Default timezone when none is configured */
export const DEFAULT_TIMEZONE = "Europe/London";

/** Pad a number to two digits */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Parse a UTC ISO string into a ZonedDateTime in the given timezone */
export const utcToZoned = (
  utcIso: string,
  tz: string,
): Temporal.ZonedDateTime =>
  Temporal.Instant.fromEpochMilliseconds(
    new Date(utcIso).getTime(),
  ).toZonedDateTimeISO(tz);

/**
 * Get today's date as YYYY-MM-DD in the given timezone.
 */
export const todayInTz = (tz: string): string =>
  Temporal.Now.plainDateISO(tz).toString();

/**
 * Strict datetime-local shape: a calendar date optionally followed by a
 * wall-clock time. Deliberately excludes any UTC designator (`Z`), numeric
 * offset, or bracketed IANA zone — the rest of the app interprets these values
 * in the configured timezone, and `Temporal.PlainDateTime.from` would silently
 * *discard* such a suffix rather than reject it, storing a different instant.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

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
