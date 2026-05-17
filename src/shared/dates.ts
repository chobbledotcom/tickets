/**
 * Date computation for daily events
 */

import { fromAbsolute } from "@internationalized/date";
import { filter } from "#fp";
import { settings } from "#shared/db/settings.ts";
import {
  formatDatetimeInTz,
  formatDatetimeShortInTz,
  localToUtc,
  todayInTz,
} from "#shared/timezone.ts";
import type { Event, Holiday } from "#shared/types.ts";

/** Day name lookup from Date.getUTCDay() index (Sunday=0) */
export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Month names for display */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Days in each month (1-indexed, index 0 unused) */
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Is the given year a leap year? */
const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Days in a specific month (1-indexed) */
const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month]!;

/**
 * Add N months to an ISO timestamp, clamping to the last day of the target month.
 * e.g. 2026-01-31 + 1mo → 2026-02-28
 * Preserves the time component (hour/minute/second/ms).
 * Zero months returns the input with canonical ISO string formatting.
 */
export const addMonthsIso = (fromIso: string, months: number): string => {
  const d = new Date(fromIso);
  if (months === 0) return d.toISOString();
  const originalDay = d.getUTCDate();
  const targetMonth = d.getUTCMonth() + months;
  const targetDate = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      targetMonth,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const maxDay = daysInMonth(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth() + 1,
  );
  targetDate.setUTCDate(Math.min(originalDay, maxDay));
  return targetDate.toISOString();
};

/** Round a date down to the start of the current hour for cache-stable signatures */
export const startOfHour = (date: Date): Date => {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
};

/** Maximum future range when maximum_days_after is 0 (no limit) */
const MAX_FUTURE_DAYS = 730;

/** Add days to a YYYY-MM-DD date string */
export const addDays = (dateStr: string, days: number): string => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Get the day name for a YYYY-MM-DD date string */
const getDayName = (dateStr: string): string =>
  DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]!;

/** Check if a date falls within any holiday range (inclusive) */
const isHoliday = (dateStr: string, holidays: Holiday[]): boolean =>
  holidays.some((h) => dateStr >= h.start_date && dateStr <= h.end_date);

/** Generate a range of YYYY-MM-DD date strings from start to end (inclusive) */
const dateRange = (start: string, end: string): string[] => {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
};

/** Compute bookable date range for a daily event */
const bookableRange = (
  event: Event,
): { bookableDays: string[]; start: string; end: string } => {
  const todayStr = todayInTz(settings.timezone);
  const start = addDays(todayStr, event.minimum_days_before);
  const maxDays =
    event.maximum_days_after === 0 ? MAX_FUTURE_DAYS : event.maximum_days_after;
  const end = addDays(todayStr, maxDays);
  return { bookableDays: event.bookable_days, end, start };
};

/** Check if a date is bookable (matches allowed day and not a holiday) */
const isBookable = (
  dateStr: string,
  bookableDays: string[],
  holidays: Holiday[],
): boolean =>
  bookableDays.includes(getDayName(dateStr)) && !isHoliday(dateStr, holidays);

/**
 * Compute available booking dates for a daily event.
 * Filters by bookable days of the week and excludes holidays.
 * Returns sorted array of YYYY-MM-DD strings.
 */
export const getAvailableDates = (
  event: Event,
  holidays: Holiday[],
): string[] => {
  const range = bookableRange(event);
  return filter((d: string) => isBookable(d, range.bookableDays, holidays))(
    dateRange(range.start, range.end),
  );
};

/**
 * Get the next available booking date for a daily event.
 * More efficient than getAvailableDates()[0] — stops at first match.
 * Returns null if no bookable dates are available.
 */
export const getNextBookableDate = (
  event: Event,
  holidays: Holiday[],
): string | null => {
  const range = bookableRange(event);
  if (range.bookableDays.length === 0) return null;

  let current = range.start;
  while (current <= range.end) {
    if (isBookable(current, range.bookableDays, holidays)) return current;
    current = addDays(current, 1);
  }
  return null;
};

/**
 * Normalize datetime-local "YYYY-MM-DDTHH:MM" to full UTC ISO string.
 * The input is interpreted as local time in the given timezone and converted to UTC.
 */
export const normalizeDatetime = (value: string, label: string): string => {
  try {
    return localToUtc(value, settings.timezone);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
};

/**
 * Format a YYYY-MM-DD date for display.
 * Returns "Monday 15 March 2026"
 */
export const formatDateLabel = (dateStr: string): string => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return `${DAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${
    MONTH_NAMES[date.getUTCMonth()]
  } ${date.getUTCFullYear()}`;
};

/**
 * Format an ISO datetime string for display in the given timezone.
 * Returns e.g. "Monday 15 June 2026 at 14:00 BST"
 */
export const formatDatetimeLabel = (iso: string): string =>
  formatDatetimeInTz(iso, settings.timezone);

/**
 * Compact ISO datetime formatter for table cells.
 * Returns e.g. "07/04/2026 14:00" in the configured timezone.
 */
export const formatDatetimeShort = (iso: string): string =>
  formatDatetimeShortInTz(iso, settings.timezone);

/**
 * Compute how many days ago an event started, relative to today in the configured timezone.
 * Returns null if the event date is today or in the future, or if the date is empty/invalid.
 * For past events, returns a positive integer (1 = yesterday).
 */
export const daysAgo = (utcIso: string): number | null => {
  if (!utcIso) return null;
  const calDate = eventDateToCalendarDate(utcIso)!;
  const todayStr = todayInTz(settings.timezone);
  if (calDate >= todayStr) return null;
  const eventMs = new Date(`${calDate}T00:00:00Z`).getTime();
  const todayMs = new Date(`${todayStr}T00:00:00Z`).getTime();
  return Math.round((todayMs - eventMs) / (1000 * 60 * 60 * 24));
};

/**
 * Convert a UTC ISO datetime to a YYYY-MM-DD calendar date in the given timezone.
 * Returns null if the input is empty or invalid.
 * Used by the calendar view to map standard event dates to calendar days.
 */
export const eventDateToCalendarDate = (utcIso: string): string | null => {
  const tz = settings.timezone;
  if (!utcIso) return null;
  try {
    const ms = new Date(utcIso).getTime();
    if (Number.isNaN(ms)) return null;
    const zoned = fromAbsolute(ms, tz);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`;
  } catch {
    return null;
  }
};
