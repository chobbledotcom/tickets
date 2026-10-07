/** The display half of the date helpers: the human-readable labels for days,
 *  months, and ranges, plus the calendar grid and month picker lists. */

import {
  addDays,
  dateRange,
  listingDateToCalendarDate,
  storedBookingSpan,
} from "#shared/dates.ts";
import {
  type DateString,
  parseDateStringOrThrow,
} from "#shared/validation/date-string.ts";
import { DAY_NAMES } from "#shared/day-names.ts";
import { DAY_MS } from "#shared/now.ts";
import {
  type DateString,
  parseDateStringOrThrow,
} from "#shared/validation/date-string.ts";

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
 * Format a YYYY-MM month string for display, for example "July 2026".
 */
export const formatMonthLabel = (month: string): string => {
  const d = new Date(`${month}-01T00:00:00Z`);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * List every YYYY-MM month within `yearsEitherSide` years of the given month's
 * year, in ascending order. For example, monthsAround("2026-03", 5) runs from
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
export const calendarGridDates = (month: string): DateString[] => {
  const first = parseDateStringOrThrow(`${month}-01`, "the calendar month");
  const firstDow = new Date(`${first}T00:00:00Z`).getUTCDay();
  const start = addDays(first, -(((firstDow + 6) % 7) + 7));
  const last = addDays(
    parseDateStringOrThrow(
      `${shiftMonth(month, 1)}-01`,
      "the next calendar month",
    ),
    -1,
  );
  const lastDow = new Date(`${last}T00:00:00Z`).getUTCDay();
  const end = addDays(last, ((7 - lastDow) % 7) + 7);
  return dateRange(start, end);
};

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
  // "<day> <month> <year>" for one end of the range, for example "2 February 2027".
  const dayMonthYear = (d: Date, month: string | undefined): string =>
    `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
  if (sameDay) {
    return dayMonthYear(s, sMonth);
  }
  if (sameMonth) {
    // Same month + year: share the month and year, for example "2–3 February 2027".
    return `${s.getUTCDate()}–${dayMonthYear(e, sMonth)}`;
  }
  if (sameYear) {
    // Same year, different month: share only the year, from the end date.
    return `${s.getUTCDate()} ${sMonth} – ${dayMonthYear(e, eMonth)}`;
  }
  return `${dayMonthYear(s, sMonth)} – ${dayMonthYear(e, eMonth)}`;
};

/**
 * Format a booking's stored `[start_at, end_at)` ISO range as a human label.
 * 1-day bookings collapse to `formatDateLabel`. Multi-day bookings use the
 * compact English range formatter, which is inclusive: it subtracts 1 day
 * from end_at, the first midnight after the booked window.
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
  const diffDays = Math.round((endMs - startMs) / DAY_MS);
  if (diffDays <= 1) return formatDateLabel(startDate);
  const lastDay = new Date(endMs - DAY_MS).toISOString().slice(0, 10);
  return formatDateRangeLabelCompactEn(startDate, lastDay);
};

/** The human-readable label for one booking's actual span.
 *
 * A stored `[date, endDate)` range gives the multi-day span. A legacy row
 * with only a start date uses the listing's fixed duration. Otherwise the
 * label is the single booked day. "" when there is no date.
 *
 * The ONE booked-range renderer the confirmation email, the /t ticket
 * cards, and the collapsed package displays share. No surface can disagree
 * about a booking's stay. */
export const bookedRangeLabel = (
  date: string | null,
  endDate: string | null,
  fallbackDurationDays = 1,
): string => {
  if (!date) return "";
  const { lastDay: storedLastDay, start } = storedBookingSpan(date, endDate);
  const lastDay =
    storedLastDay ??
    (fallbackDurationDays > 1
      ? addDays(start, fallbackDurationDays - 1)
      : null);
  return lastDay && lastDay > start
    ? formatDateRangeLabelCompactEn(start, lastDay)
    : formatDateLabel(start);
};

/**
 * Format a UTC ISO datetime as a date-only label in the configured timezone,
 * for example "Monday 15 June 2026" — no time. Returns "" for an
 * empty/invalid input. Used where a stored timestamp reads as a plain
 * published date (the public news post page).
 */
export const formatDateLongLabel = (utcIso: string): string => {
  const calendarDate = listingDateToCalendarDate(utcIso);
  return calendarDate ? formatDateLabel(calendarDate) : "";
};
