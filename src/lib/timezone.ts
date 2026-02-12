/**
 * Timezone conversion utilities using Intl.DateTimeFormat.
 *
 * Since Deno doesn't support Temporal yet, we use the Intl API to:
 * - Get "today" in a configured timezone
 * - Convert naive datetime-local inputs (interpreted as local time) to UTC
 * - Format UTC datetimes for display in a timezone
 */

/** Default timezone when none is configured */
export const DEFAULT_TIMEZONE = "Europe/London";

/** Parsed numeric date/time components in a timezone */
type TzParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * Extract numeric date/time parts from a Date in a given timezone.
 * Uses month: "numeric" so all parts parse as integers.
 */
const tzParts = (date: Date, tz: string): TzParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): number =>
    parseInt(parts.find((p) => p.type === type)!.value, 10);

  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
};

/** Pad a number to two digits */
export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Format numeric parts as YYYY-MM-DD */
const fmtDate = (p: TzParts): string =>
  `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;

/** Format numeric parts as YYYY-MM-DDTHH:MM (for datetime-local inputs) */
const fmtInputDatetime = (p: TzParts): string =>
  `${fmtDate(p)}T${pad2(p.hour)}:${pad2(p.minute)}`;

/**
 * Get the timezone offset in milliseconds at a given instant.
 * Returns (local time - UTC) so a timezone ahead of UTC returns positive.
 */
const getTimezoneOffsetMs = (date: Date, tz: string): number => {
  const p = tzParts(date, tz);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return localAsUtc - date.getTime();
};

/**
 * Get today's date as YYYY-MM-DD in the given timezone.
 */
export const todayInTz = (tz: string): string =>
  fmtDate(tzParts(new Date(), tz));

/**
 * Convert a naive datetime-local value (YYYY-MM-DDTHH:MM) to a UTC ISO string,
 * interpreting the value as local time in the given timezone.
 *
 * Handles DST transitions by double-checking the offset at the result time.
 */
export const localToUtc = (naive: string, tz: string): string => {
  const normalized = naive.length === 16 ? `${naive}:00.000Z` : naive;
  const asUtc = new Date(normalized);
  if (Number.isNaN(asUtc.getTime())) {
    throw new Error(`Invalid datetime: ${naive}`);
  }

  const offset = getTimezoneOffsetMs(asUtc, tz);
  const result = new Date(asUtc.getTime() - offset);

  // Re-check at the actual result time to handle DST boundaries
  const offset2 = getTimezoneOffsetMs(result, tz);
  if (offset !== offset2) {
    return new Date(asUtc.getTime() - offset2).toISOString();
  }

  return result.toISOString();
};

/**
 * Format a UTC ISO datetime string for display in the given timezone.
 * Returns e.g. "Monday 15 June 2026 at 14:00 BST"
 *
 * Uses a separate formatter with long weekday/month names and timezone abbreviation.
 */
export const formatDatetimeInTz = (utcIso: string, tz: string): string => {
  const date = new Date(utcIso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)!.value;

  const hour = parseInt(get("hour"), 10) % 24;

  return `${get("weekday")} ${parseInt(get("day"), 10)} ${get("month")} ${get("year")} at ${pad2(hour)}:${pad2(parseInt(get("minute"), 10))} ${get("timeZoneName")}`;
};

/**
 * Convert a UTC ISO datetime string to a datetime-local input value
 * (YYYY-MM-DDTHH:MM) in the given timezone.
 * Used for pre-populating form inputs with timezone-adjusted values.
 */
export const utcToLocalInput = (utcIso: string, tz: string): string =>
  fmtInputDatetime(tzParts(new Date(utcIso), tz));

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
