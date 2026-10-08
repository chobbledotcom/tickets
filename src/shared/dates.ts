/**
 * Date computation for daily listings
 */

import type { Holiday } from "#db/holidays.ts";
import { settings } from "#db/settings.ts";
import { filter, once } from "#fp";
import { DAY_NAMES } from "#shared/day-names.ts";
import { DAY_MS } from "#shared/now.ts";
import {
  formatDatetimeInTz,
  formatDatetimeShortInTz,
  localToUtc,
  todayInTz,
  utcToZoned,
} from "#shared/timezone.ts";
import {
  type DateString,
  isRealCalendarDay,
  parseDateString,
  parseDateStringOrThrow,
} from "#shared/validation/date-string.ts";
import { clampDurationDays, type Listing, type SortableListing } from "#types";

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

/** Add days to a real-calendar-day date. The caller's boundary brands the
 *  value, so a skip-the-parser caller cannot type-check. */
export const addDays = (dateStr: DateString, days: number): DateString => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10) as DateString;
};

/** Epoch milliseconds at midnight UTC of a YYYY-MM-DD day */
const dayStartMs = (dateStr: string): number =>
  new Date(`${dateStr}T00:00:00Z`).getTime();

/** Whole days from one YYYY-MM-DD day to another (negative when `to` is
 * earlier). Both days are read at midnight UTC, so the division is exact. */
const wholeDaysBetween = (from: string, to: string): number =>
  Math.round((dayStartMs(to) - dayStartMs(from)) / DAY_MS);

/** Get the day name for a YYYY-MM-DD date string */
const getDayName = (dateStr: string): string =>
  DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]!;

/** Check if a date falls within any holiday range (inclusive) */
const isHoliday = (dateStr: string, holidays: Holiday[]): boolean =>
  holidays.some((h) => dateStr >= h.start_date && dateStr <= h.end_date);

/** Generate a range of YYYY-MM-DD date strings from start to end (inclusive).
 * A start past the end is an empty range: Array.from reads the negative
 * length as zero. */
export const dateRange = (start: DateString, end: DateString): DateString[] => {
  const dayCount = wholeDaysBetween(start, end) + 1;
  return Array.from({ length: dayCount }, (_, i) => addDays(start, i));
};

/** The window of days a daily listing can currently be booked in. */
interface BookingWindow {
  bookableDays: string[];
  end: DateString;
  start: DateString;
}

/** Compute bookable date range for a daily listing */
const bookableRange = (listing: SortableListing): BookingWindow => {
  const today = parseDateStringOrThrow(
    todayInTz(settings.timezone),
    "the configured timezone's clock",
  );
  const start = addDays(today, listing.minimum_days_before);
  const maxDays =
    listing.maximum_days_after === 0
      ? MAX_FUTURE_DAYS
      : listing.maximum_days_after;
  const end = addDays(today, maxDays);
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
 * Can a booking of `durationDays` days start on a given day? Every day in
 * `[start, start + durationDays)` must pass `isBookable` and stay within the
 * window's end (inclusive).
 */
const canStartOn =
  (range: BookingWindow, durationDays: number, holidays: Holiday[]) =>
  (start: DateString): boolean =>
    Array.from({ length: durationDays }, (_, i) => addDays(start, i)).every(
      (day) =>
        day <= range.end && isBookable(day, range.bookableDays, holidays),
    );

/**
 * A `duration_days > 1` listing excludes a start date whose full range hits a
 * non-bookable day or runs past the booking window.
 *
 * `durationOverride` exists for a customisable-days listing, where
 * `duration_days` is only the *maximum*. The date list is built for a single
 * day, and the chosen span is validated at submit by
 * {@link isBookingRangeValid}.
 */
export const getAvailableDates = (
  listing: Listing,
  holidays: Holiday[],
  durationOverride?: number,
): DateString[] => {
  const range = bookableRange(listing);
  const duration = clampDurationDays(durationOverride ?? listing.duration_days);
  return filter(canStartOn(range, duration, holidays))(
    dateRange(range.start, range.end),
  );
};

/**
 * Available start dates for a daily listing's booking/date pickers.
 * Customisable-days listings use single-day availability: the span is chosen
 * separately and validated at submit time. Every individually-bookable start
 * is offered. Other listings use their fixed duration.
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

/** Parse a user-supplied YYYY-MM-DD value (a `?date=` query param): the string
 * when well-formed and a real calendar date, else null. */
export const parseIsoDateParam = (value: string | null): string | null => {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return isRealCalendarDay(value) ? value : null;
};

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
  const branded = parseDateString(date);
  if (branded === null) return false;
  if (branded < range.start) return false;
  return canStartOn(range, clampDurationDays(days), holidays)(branded);
};

/**
 * Get the next available booking date for a daily listing.
 * More efficient than getAvailableDates()[0] — stops checking spans at the
 * first match. Returns null if no bookable dates are available.
 */
export const getNextBookableDate = (
  listing: SortableListing,
  holidays: Holiday[],
): DateString | null => {
  const range = bookableRange(listing);
  const duration = clampDurationDays(listing.duration_days);
  const first = dateRange(range.start, range.end).find(
    canStartOn(range, duration, holidays),
  );
  return first === undefined ? null : first;
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

/** Every YYYY-MM-DD day a stored `[date, endDate)` booking covers. The end is
 * exclusive, and a booking with no end recorded covers only the day it starts. */
/** The stored `[date, endDate)` booking's start and exclusive end day. The
 *  end is one day before the stored exclusive end; with no end stored the
 *  span covers only the start day. A stored date the rule refuses stops the
 *  request loudly. */
export const storedBookingSpan = (
  date: string,
  endDate: string | null,
): { lastDay: DateString | null; start: DateString } => {
  const start = parseDateStringOrThrow(date, "a stored booking date");
  const lastDay = endDate
    ? addDays(parseDateStringOrThrow(endDate, "a stored booking end date"), -1)
    : null;
  return { lastDay, start };
};

export const coveredDays = (
  date: string | null,
  endDate: string | null,
): DateString[] => {
  if (!date) return [];
  const { lastDay, start } = storedBookingSpan(date, endDate);
  return lastDay !== null && lastDay > start
    ? dateRange(start, lastDay)
    : [start];
};

/** The whole day count of a stored `[start_at, end_at)` booking range — the
 * customisable day count the buyer chose. A missing or degenerate range is 1. */
export const bookedSpanDays = (
  startIso: string | null,
  endIso: string | null,
): number => {
  if (!startIso || !endIso) return 1;
  const diffDays = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / DAY_MS,
  );
  return diffDays > 1 ? diffDays : 1;
};

/** The dated entry whose booked range ends last — the stay covering a whole
 * package bundle — or null when every entry is date-less (a standard package).
 * A dated entry with no stored end (a single-day booking, or a legacy row)
 * sorts below any ranged stay. Shared by the collapsed email/SVG displays and
 * the /t package card, so every surface picks the SAME representative stay. */
export const widestDatedEntry = <
  T extends { attendee: { date: string | null; end_date: string | null } },
>(
  entries: readonly T[],
): T | null => {
  let widest: T | null = null;
  let widestEnd = "";
  for (const entry of entries) {
    if (!entry.attendee.date) continue;
    const end = String(entry.attendee.end_date ?? "");
    if (widest !== null && end <= widestEnd) continue;
    widest = entry;
    widestEnd = end;
  }
  return widest;
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
  return wholeDaysBetween(calDate, todayStr);
};

/**
 * Built on first use, not at module load. Constructing the first Intl formatter
 * in an isolate loads ~12ms of ICU data; this is the only Intl construction that
 * would otherwise run at module scope on the edge, and it feeds a single
 * owner-only page (the Support page's "you last submitted … ago"). Deferring it
 * keeps that ICU init off the cold-boot path, so requests that format nothing
 * (webhooks, redirects, health checks) never pay it.
 */
const relativeTime = once(
  () => new Intl.RelativeTimeFormat("en", { numeric: "auto" }),
);

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
  if (days >= 1) return relativeTime().format(-days, "day");
  if (hours >= 1) return relativeTime().format(-hours, "hour");
  if (minutes >= 1) return relativeTime().format(-minutes, "minute");
  return relativeTime().format(-seconds, "second");
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
