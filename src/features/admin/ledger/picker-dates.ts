import { dateRange } from "#shared/dates.ts";
import { epochMsToTzDate } from "#shared/timezone.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
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
  const brandedToday = parseDateStringOrThrow(
    today,
    "the configured timezone's clock",
  );
  const startDay = parseDateStringOrThrow(
    epochMsToTzDate(bounds.minMs, tz),
    "a picker bound date",
  );
  const latest = parseDateStringOrThrow(
    epochMsToTzDate(bounds.maxMs, tz),
    "a picker bound date",
  );
  const endDay = latest > brandedToday ? latest : brandedToday;
  return selectableDates(dateRange(startDay, endDay));
};
