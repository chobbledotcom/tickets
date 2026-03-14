/**
 * Timezone conversion utilities using @internationalized/date.
 *
 * Wraps the library to provide simple string-in/string-out functions
 * for the rest of the codebase, with correct DST handling and
 * explicit disambiguation.
 */

import {
  fromAbsolute,
  parseDateTime,
  today as libToday,
  toZoned,
} from "@internationalized/date";

/** Default timezone when none is configured */
export const DEFAULT_TIMEZONE = "Europe/London";

/** Pad a number to two digits */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Parse a UTC ISO string into a ZonedDateTime in the given timezone */
const utcToZoned = (utcIso: string, tz: string) =>
  fromAbsolute(new Date(utcIso).getTime(), tz);

/**
 * Get today's date as YYYY-MM-DD in the given timezone.
 */
export const todayInTz = (tz: string): string =>
  libToday(tz).toString();

/**
 * Convert a naive datetime-local value (YYYY-MM-DDTHH:MM) to a UTC ISO string,
 * interpreting the value as local time in the given timezone.
 *
 * Uses 'compatible' disambiguation: spring-forward gaps resolve to the later
 * (post-transition) time; fall-back overlaps resolve to the earlier occurrence.
 */
export const localToUtc = (naive: string, tz: string): string => {
  try {
    const dt = parseDateTime(naive);
    const zoned = toZoned(dt, tz, "compatible");
    return zoned.toAbsoluteString();
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
    timeZone: tz,
    weekday: "long",
    month: "long",
    timeZoneName: "short",
  }).formatToParts(new Date(utcIso));

  const get = (type: string): string =>
    parts.find((p) => p.type === type)!.value;

  return `${get("weekday")} ${day} ${get("month")} ${year} at ${pad2(hour)}:${pad2(minute)} ${get("timeZoneName")}`;
};

/**
 * Convert a UTC ISO datetime string to a datetime-local input value
 * (YYYY-MM-DDTHH:MM) in the given timezone.
 * Used for pre-populating form inputs with timezone-adjusted values.
 */
export const utcToLocalInput = (utcIso: string, tz: string): string => {
  const z = utcToZoned(utcIso, tz);
  return `${z.year}-${pad2(z.month)}-${pad2(z.day)}T${pad2(z.hour)}:${pad2(z.minute)}`;
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
    parseDateTime(value);
    return true;
  } catch {
    return false;
  }
};
