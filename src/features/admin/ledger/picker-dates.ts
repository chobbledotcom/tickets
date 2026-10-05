import { dateRange } from "#shared/dates.ts";
import { epochMsToTzDate } from "#shared/timezone.ts";
import {
  type DatePickerDate,
  selectableDates,
} from "#templates/date-picker.tsx";

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
  return selectableDates(dateRange(startDay, endDay));
};
