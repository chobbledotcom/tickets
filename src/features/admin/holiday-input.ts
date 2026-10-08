/** The holiday input assembly and its date reads, kept pure so the coverage
 *  merger sees them exercised from one isolate. */

import type { HolidayInput } from "#db/holidays.ts";
import {
  dateRange,
  optionalDateString,
  requireDateString,
} from "#shared/rest/crud-parsers.ts";
import type { Result } from "#shared/result.ts";
import type { DateString } from "#shared/validation/date-string.ts";

/** Assemble one holiday input from its name and the cleaned date range. */
export const holidayInput = (
  name: string,
  dates: { endDate: DateString; startDate: DateString },
): HolidayInput => ({
  endDate: dates.endDate,
  name,
  startDate: dates.startDate,
});

/** Read the start and end dates of one holiday: required on create, falling
 *  back to the stored dates on update. */
export const readDates = (
  body: Record<string, unknown>,
  existing: { end_date: string; start_date: string } | null,
): Result<{ endDate: DateString; startDate: DateString }> =>
  dateRange(
    existing
      ? optionalDateString(body, "start_date", existing.start_date)
      : requireDateString(body, "start_date"),
    existing
      ? optionalDateString(body, "end_date", existing.end_date)
      : requireDateString(body, "end_date"),
  );
