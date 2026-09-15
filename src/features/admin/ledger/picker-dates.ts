import { dateRange, formatDateLabel } from "#shared/dates.ts";
import { epochMsToTzDate } from "#shared/timezone.ts";
import type { DatePickerDate } from "#templates/date-picker.tsx";

/** The given ISO days as fully selectable picker entries, each labelled with
 * its own formatted date. */
export const selectablePickerDates = (
  values: readonly string[],
): DatePickerDate[] =>
  values.map((value) => ({
    label: formatDateLabel(value),
    selectable: true,
    value,
  }));

/** Build the selectable Money days covered by stored activity. */
export const pickerDatesFromBounds = (
  bounds: { minMs: number; maxMs: number } | null,
  today: string,
  tz: string,
): DatePickerDate[] => {
  if (!bounds) return [];
  const startDay = epochMsToTzDate(bounds.minMs, tz);
  const latest = epochMsToTzDate(bounds.maxMs, tz);
  const endDay = latest > today ? latest : today;
  return selectablePickerDates(dateRange(startDay, endDay));
};
