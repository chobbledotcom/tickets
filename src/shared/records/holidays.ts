/**
 * The holiday record: its table, its one write rule, and its admin surface.
 * The pages and the JSON API both read this declaration.
 */

import { type Holiday, type HolidayInput, holidays } from "#db/holidays.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import {
  defineNamedRowRecord,
  withNameLimit,
} from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The one holiday rule: a name the form can save again, and an end on or
 * after the day the holiday starts. Both doors answer these messages. */
export const holidayRule = withNameLimit(
  (input: HolidayInput): Result<HolidayInput> =>
    input.endDate < input.startDate
      ? errorResult(t("error.end_date_before_start"))
      : okResult(input),
);

export const holidayRecord = defineNamedRowRecord<
  RecordShapeOf<Holiday, HolidayInput>
>()({
  activityName: "Holiday",
  api: ADMIN_API_RESOURCES.holidays,
  getAll: holidays.getAll,
  nameLabel: "holidays.name_label",
  rule: holidayRule,
  surface: "holidays",
  table: holidays.table,
});
