/**
 * Holidays table operations
 */

import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import { tableCache } from "#db/table-cache.ts";
import { filter } from "#fp";
import type { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import { requestCache } from "#shared/request-cache.ts";
import type { FieldsInput } from "#shared/rest/field-specs.ts";
import { todayInTz } from "#shared/timezone.ts";

export type Holiday = DecodedRowOf<"holidays">;

/** The dates carry the `DateString` a boundary checks before a write. */
export type HolidayInput = FieldsInput<typeof HOLIDAY_FIELDS>;

/** Every holiday in start order, cached for the request. The name is
 * decrypted by its codec. */
export const holidays = tableCache(
  tables.holidays,
  requestCache(() =>
    readRows(from(tables.holidays).sortedBy("start_date").everyColumn()),
  ),
);

/**
 * Get active holidays (end_date >= today) for date computation (from cache).
 * "today" is computed in the configured timezone.
 */
export const getActiveHolidays = async (): Promise<Holiday[]> => {
  const today = todayInTz(settings.timezone);
  const all = await holidays.getAll();
  return filter((h: Holiday) => h.end_date >= today)(all);
};
