/**
 * Date computation for daily events
 */

import { filter, pipe } from "#fp";
import { formatDatetimeInTz, localToUtc, todayInTz } from "#lib/timezone.ts";
import type { Event, Holiday } from "#lib/types.ts";

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
  DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()] as string;

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

/**
 * Compute available booking dates for a daily event.
 * Filters by bookable days of the week and excludes holidays.
 * Returns sorted array of YYYY-MM-DD strings.
 */
export const getAvailableDates = (
  event: Event,
  holidays: Holiday[],
  tz: string,
): string[] => {
  const bookableDays = JSON.parse(event.bookable_days) as string[];
  const todayStr = todayInTz(tz);
  const start = addDays(todayStr, event.minimum_days_before);
  const maxDays =
    event.maximum_days_after === 0
      ? MAX_FUTURE_DAYS
      : event.maximum_days_after;
  const end = addDays(todayStr, maxDays);

  return pipe(
    filter((d: string) => bookableDays.includes(getDayName(d))),
    filter((d: string) => !isHoliday(d, holidays)),
  )(dateRange(start, end));
};

/**
 * Normalize datetime-local "YYYY-MM-DDTHH:MM" to full UTC ISO string.
 * The input is interpreted as local time in the given timezone and converted to UTC.
 */
export const normalizeDatetime = (value: string, label: string, tz: string): string => {
  try {
    return localToUtc(value, tz);
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
  return `${DAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

/**
 * Format an ISO datetime string for display in the given timezone.
 * Returns e.g. "Monday 15 June 2026 at 14:00 BST"
 */
export const formatDatetimeLabel = (iso: string, tz: string): string =>
  formatDatetimeInTz(iso, tz);
