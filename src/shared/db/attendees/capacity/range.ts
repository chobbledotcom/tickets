import { filter, map, pipe, sumOf } from "#fp";
import { addDays } from "#shared/dates.ts";
import type { LineBooking } from "#shared/db/attendee-types.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import { normalizeDurationDays } from "#shared/types.ts";

/** Convert a nullable date to the stored half-open range. */
export const dateToStartEnd = (
  date: string | null,
  durationDays = 1,
): { startAt: string | null; endAt: string | null } => {
  if (!date) return { endAt: null, startAt: null };
  const range = dateToRange(date, durationDays);
  return { endAt: range.endAt, startAt: range.startAt };
};

/** The stored start timestamp for a booking line. */
export const bookingStartAt = (
  booking: Pick<LineBooking, "date">,
): string | null => dateToStartEnd(booking.date).startAt;

/** Expand a daily-listing range into individual day strings. */
export const expandDailyRange = (
  date: string,
  durationDays: number,
): string[] => {
  const duration = normalizeDurationDays(durationDays);
  return Array.from({ length: duration }, (_, i) => addDays(date, i));
};

/** Half-open span covering a non-empty set of YYYY-MM-DD days. */
export const daySpan = (days: string[]): { startAt: string; endAt: string } => {
  const sorted = days.toSorted();
  return {
    endAt: dateToRange(sorted.at(-1)!).endAt,
    startAt: `${sorted[0]!}T00:00:00Z`,
  };
};

/** A booking row's stored range and quantity. */
export interface IntervalRow {
  end_at: string;
  quantity: number;
  start_at: string;
}

const sumQuantity = sumOf((row: { quantity: number }) => row.quantity);

/** Whether a stored booking overlaps one day. String comparison mirrors the
 * SQLite overlap check byte-for-byte. */
export const overlapsDay = (day: string): ((row: IntervalRow) => boolean) => {
  const { startAt, endAt } = dateToRange(day);
  return (row): boolean => row.start_at < endAt && row.end_at > startAt;
};

/** Per-day quantity sums from rows fetched for the whole span. */
export const perDayLoads = (
  rows: IntervalRow[],
  days: string[],
): Map<string, number> =>
  new Map(
    map((day: string): [string, number] => [
      day,
      pipe(filter(overlapsDay(day)), sumQuantity)(rows),
    ])(days),
  );
