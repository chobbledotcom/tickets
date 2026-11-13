/**
 * The holiday record: its table, its one write rule, and its admin surface.
 * The pages and the JSON API both read this declaration.
 */

import { type Holiday, type HolidayInput, holidays } from "#db/holidays.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The one holiday rule: a holiday ends on or after the day it starts. Both
 * doors answer this message. */
export const validateDateRange = (input: HolidayInput): Result<HolidayInput> =>
  input.endDate < input.startDate
    ? errorResult(t("error.end_date_before_start"))
    : okResult(input);

export const holidayRecord = defineNamedRowRecord<
  RecordShapeOf<Holiday, HolidayInput>
>()({
  activityName: "Holiday",
  api: ADMIN_API_RESOURCES.holidays,
  getAll: holidays.getAll,
  nameLabel: "holidays.name_label",
  rule: validateDateRange,
  surface: "holidays",
  table: holidays.table,
});
