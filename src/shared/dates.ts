/**
 * Date computation for daily listings
 */

import { filter } from "#fp";
import { settings } from "#shared/db/settings.ts";
import {
  formatDatetimeInTz,
  formatDatetimeShortInTz,
  localToUtc,
  todayInTz,
  utcToZoned,
} from "#shared/timezone.ts";
import {
  type Holiday,
  type Listing,
  normalizeDurationDays,
} from "#shared/types.ts";

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
export const dateRange = (start: string, end: string): string[] => {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
};

/** Compute bookable date range for a daily listing */
const bookableRange = (
  listing: Listing,
): { bookableDays: string[]; start: string; end: string } => {
  const todayStr = todayInTz(settings.timezone);
  const start = addDays(todayStr, listing.minimum_days_before);
  const maxDays =
    listing.maximum_days_after === 0
      ? MAX_FUTURE_DAYS
      : listing.maximum_days_after;
  const end = addDays(todayStr, maxDays);
  return { bookableDays: listing.bookable_days, end, start };
};

/** Check if a date is bookable (matches allowed day and not a holiday) */
const isBookable = (
  dateStr: string,
  bookableDays: string[],
  holidays: Holiday[],
): boolean =>
  bookableDays.includes(getDayName(dateStr)) && !isHoliday(dateStr, holidays);

/**
 * Check if every day in a multi-day booking starting at `start` is bookable.
 * All days in `[start, start + durationDays)` must pass `isBookable` and
 * stay within `endLimit` (inclusive).
 */
const isRangeBookable = (
  start: string,
  durationDays: number,
  bookableDays: string[],
  holidays: Holiday[],
  endLimit: string,
): boolean => {
  for (let i = 0; i < durationDays; i++) {
    const day = addDays(start, i);
    if (day > endLimit) return false;
    if (!isBookable(day, bookableDays, holidays)) return false;
  }
  return true;
};

/**
 * Compute available booking dates for a daily listing.
 * Filters by bookable days of the week and excludes holidays.
 * For listings with `duration_days > 1`, excludes start dates whose full range
 * would hit a non-bookable day or extend past the booking window.
 *
 * `durationOverride` lets callers compute availability for a span other than
 * the listing's stored `duration_days` — used for "customisable days" listings,
 * where `duration_days` is only the *maximum*, so the date list is built for a
 * single day (every individually-bookable start) and the chosen span is
 * validated separately at submit time via {@link isBookingRangeValid}.
 *
 * Returns sorted array of YYYY-MM-DD strings.
 */
export const getAvailableDates = (
  listing: Listing,
  holidays: Holiday[],
  durationOverride?: number,
): string[] => {
  const range = bookableRange(listing);
  const duration = normalizeDurationDays(
    durationOverride ?? listing.duration_days,
  );
  return filter((d: string) =>
    isRangeBookable(d, duration, range.bookableDays, holidays, range.end),
  )(dateRange(range.start, range.end));
};

/**
 * Available start dates for a daily listing's booking/date pickers.
 * Customisable-days listings use single-day availability — the span is chosen
 * separately and validated at submit time — so every individually-bookable
 * start is offered; other listings use their fixed duration.
 */
export const getBookableStartDates = (
  listing: Listing,
  holidays: Holiday[],
): string[] =>
  getAvailableDates(
    listing,
    holidays,
    listing.customisable_days ? 1 : undefined,
  );

/**
 * Whether booking `days` consecutive days starting on `date` is valid for a
 * daily listing: every day must be a bookable weekday, fall outside all
 * holidays, and stay within the listing's booking window. Used to enforce the
 * visitor's chosen span on "customisable days" listings at submit time, where
 * the day count isn't known when the date list is rendered.
 */
export const isBookingRangeValid = (
  listing: Listing,
  date: string,
  days: number,
  holidays: Holiday[],
): boolean => {
  const range = bookableRange(listing);
  if (date < range.start) return false;
  return isRangeBookable(
    date,
    normalizeDurationDays(days),
    range.bookableDays,
    holidays,
    range.end,
  );
};

/**
 * Get the next available booking date for a daily listing.
 * More efficient than getAvailableDates()[0] — stops at first match.
 * Returns null if no bookable dates are available.
 */
export const getNextBookableDate = (
  listing: Listing,
  holidays: Holiday[],
): string | null => {
  const range = bookableRange(listing);
  if (range.bookableDays.length === 0) return null;
  const duration = normalizeDurationDays(listing.duration_days);

  let current = range.start;
  while (current <= range.end) {
    if (
      isRangeBookable(
        current,
        duration,
        range.bookableDays,
        holidays,
        range.end,
      )
    ) {
      return current;
    }
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
 * Shift a YYYY-MM month string by `delta` months (negative goes backwards).
 * Crosses year boundaries: shiftMonth("2026-12", 1) → "2027-01".
 */
export const shiftMonth = (month: string, delta: number): string => {
  const d = new Date(`${month}-01T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1))
    .toISOString()
    .slice(0, 7);
};

/**
 * Format a YYYY-MM month string for display, e.g. "July 2026".
 */
export const formatMonthLabel = (month: string): string => {
  const d = new Date(`${month}-01T00:00:00Z`);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * List every YYYY-MM month within `yearsEitherSide` years of the given month's
 * year, in ascending order. e.g. monthsAround("2026-03", 5) runs from
 * "2021-01" to "2031-12". Used to populate the calendar's month picker.
 */
export const monthsAround = (
  month: string,
  yearsEitherSide: number,
): string[] => {
  const year = new Date(`${month}-01T00:00:00Z`).getUTCFullYear();
  const start = `${year - yearsEitherSide}-01`;
  const count = (yearsEitherSide * 2 + 1) * 12;
  return Array.from({ length: count }, (_, i) => shiftMonth(start, i));
};

/**
 * Build the calendar grid for a YYYY-MM month as a flat list of YYYY-MM-DD
 * strings. The grid is whole Monday→Sunday weeks spanning the month plus one
 * extra full week on each side, so adjacent-month context is always visible.
 */
export const calendarGridDates = (month: string): string[] => {
  const first = `${month}-01`;
  const firstDow = new Date(`${first}T00:00:00Z`).getUTCDay();
  const start = addDays(first, -(((firstDow + 6) % 7) + 7));
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const lastDow = new Date(`${last}T00:00:00Z`).getUTCDay();
  const end = addDays(last, ((7 - lastDow) % 7) + 7);
  return dateRange(start, end);
};

/**
 * Compact English date-range formatter. Uses an en dash (`–`) for ranges.
 *
 * - Same day: `2 February 2027`
 * - Same month + same year: `2–3 February 2027`
 * - Different month + same year: `2 February – 3 March 2027`
 * - Different year: `2 February 2027 – 3 February 2028`
 *
 * Kept as a dedicated helper so i18n replacements can target locale behavior.
 */
export const formatDateRangeLabelCompactEn = (
  startDateStr: string,
  endDateStr: string,
): string => {
  const s = new Date(`${startDateStr}T00:00:00Z`);
  const e = new Date(`${endDateStr}T00:00:00Z`);
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const sameMonth = sameYear && s.getUTCMonth() === e.getUTCMonth();
  const sameDay = sameMonth && s.getUTCDate() === e.getUTCDate();
  const sMonth = MONTH_NAMES[s.getUTCMonth()];
  const eMonth = MONTH_NAMES[e.getUTCMonth()];
  if (sameDay) {
    return `${s.getUTCDate()} ${sMonth} ${s.getUTCFullYear()}`;
  }
  if (sameMonth) {
    return `${s.getUTCDate()}–${e.getUTCDate()} ${sMonth} ${s.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${s.getUTCDate()} ${sMonth} – ${e.getUTCDate()} ${eMonth} ${s.getUTCFullYear()}`;
  }
  return `${s.getUTCDate()} ${sMonth} ${s.getUTCFullYear()} – ${e.getUTCDate()} ${eMonth} ${e.getUTCFullYear()}`;
};

/**
 * Format a booking's stored `[start_at, end_at)` ISO range as a human label.
 * 1-day bookings collapse to `formatDateLabel`; multi-day bookings use the
 * compact English range formatter (inclusive — subtracts 1 day from end_at,
 * which is the first midnight *after* the booked window).
 */
export const formatDateRangeLabel = (
  startIso: string | null,
  endIso: string | null,
): string => {
  if (!startIso) return "";
  const startDate = startIso.slice(0, 10);
  if (!endIso) return formatDateLabel(startDate);
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const diffDays = Math.round((endMs - startMs) / 86_400_000);
  if (diffDays <= 1) return formatDateLabel(startDate);
  const lastDay = new Date(endMs - 86_400_000).toISOString().slice(0, 10);
  return formatDateRangeLabelCompactEn(startDate, lastDay);
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
 * Compute how many days ago an listing started, relative to today in the configured timezone.
 * Returns null if the listing date is today or in the future, or if the date is empty/invalid.
 * For past listings, returns a positive integer (1 = yesterday).
 */
export const daysAgo = (utcIso: string): number | null => {
  if (!utcIso) return null;
  const calDate = listingDateToCalendarDate(utcIso);
  if (!calDate) return null;
  const todayStr = todayInTz(settings.timezone);
  if (calDate >= todayStr) return null;
  const listingMs = new Date(`${calDate}T00:00:00Z`).getTime();
  const todayMs = new Date(`${todayStr}T00:00:00Z`).getTime();
  return Math.round((todayMs - listingMs) / (1000 * 60 * 60 * 24));
};

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Human "time ago" label for a past ISO timestamp, relative to `nowMsValue`
 * (epoch ms), via Intl.RelativeTimeFormat in the largest whole unit that
 * applies — e.g. "now", "5 minutes ago", "yesterday", "2 days ago". Returns
 * null for an unparseable or future timestamp.
 */
export const formatTimeAgo = (
  iso: string,
  nowMsValue: number,
): string | null => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.floor((nowMsValue - then) / 1000);
  if (seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return RELATIVE_TIME.format(-days, "day");
  if (hours >= 1) return RELATIVE_TIME.format(-hours, "hour");
  if (minutes >= 1) return RELATIVE_TIME.format(-minutes, "minute");
  return RELATIVE_TIME.format(-seconds, "second");
};

/**
 * Convert a UTC ISO datetime to a YYYY-MM-DD calendar date in the given timezone.
 * Returns null if the input is empty or invalid.
 * Used by the calendar view to map standard listing dates to calendar days.
 */
export const listingDateToCalendarDate = (utcIso: string): string | null => {
  if (!utcIso) return null;
  try {
    return utcToZoned(utcIso, settings.timezone).toPlainDate().toString();
  } catch {
    return null;
  }
};
