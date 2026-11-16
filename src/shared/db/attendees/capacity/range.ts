import { dateToRange } from "#db/capacity.ts";
import { greaterThan, lessThan, valued } from "#db/select/expression.ts";
import type { Node, Query, Valued } from "#db/select/shape.ts";
import { filter, map, pipe, sumOf } from "#fp";
import { addDays } from "#shared/dates.ts";
import type { DateString } from "#shared/validation/date-string.ts";
import { clampDurationDays } from "#types";

/** Convert a nullable date to the stored half-open range. */
export const dateToStartEnd = (
  date: string | null,
  durationDays = 1,
): { startAt: string | null; endAt: string | null } => {
  if (!date) return { endAt: null, startAt: null };
  const range = dateToRange(date, durationDays);
  return { endAt: range.endAt, startAt: range.startAt };
};

/** Expand a daily-listing range into individual day strings. The caller's
 *  boundary brands the stored or submitted date. */
export const expandDailyRange = (
  date: DateString,
  durationDays: number,
): string[] => {
  const duration = clampDurationDays(durationDays);
  return Array.from({ length: duration }, (_, i) => addDays(date, i));
};

/** Half-open span covering a non-empty set of YYYY-MM-DD days. */
const daySpan = (days: string[]): { startAt: string; endAt: string } => {
  const sorted = days.toSorted();
  return {
    endAt: dateToRange(sorted.at(-1)!).endAt,
    startAt: `${sorted[0]!}T00:00:00Z`,
  };
};

type Line = Node<"listing_attendees">;

/** The statement that reads the range and the quantity of each line of `read`
 *  whose range overlaps the days, under the id that `owner` picks. A line that
 *  overlaps holds both ends of its range. */
export const spanLoadsOf = <Root extends Line, First>(
  read: Query<Root, First>,
  days: string[],
  owner: Valued<Root, number>,
) => {
  const { startAt, endAt } = daySpan(days);
  return read
    .where((line) => [
      lessThan(line.start_at, endAt),
      greaterThan(line.end_at, startAt),
    ])
    .select((line) => ({
      end_at: valued<string>(line.end_at),
      owner_id: owner(line),
      quantity: line.quantity,
      start_at: valued<string>(line.start_at),
    }));
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
