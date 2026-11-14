/**
 * Holidays table operations
 */

import { decrypt, encrypt } from "#crypto/encryption.ts";
import { fieldColumns } from "#db/common-schema.ts";
import { settings } from "#db/settings.ts";
import { defineCachedListTable } from "#db/table.ts";
import { filter } from "#fp";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import type { FieldsInput, FieldsRow } from "#shared/rest/field-specs.ts";
import { todayInTz } from "#shared/timezone.ts";

export type Holiday = FieldsRow<typeof HOLIDAY_FIELDS>;

/** The dates carry the `DateString` a boundary checks before a write. */
export type HolidayInput = FieldsInput<typeof HOLIDAY_FIELDS>;

/** Cached holidays table: name is encrypted, dates are plaintext. Writes
 * auto-invalidate the cache. */
export const holidays = defineCachedListTable<Holiday, HolidayInput>({
  name: "holidays",
  orderBy: "start_date ASC",
  primaryKey: "id",
  schema: fieldColumns(HOLIDAY_FIELDS)(encrypt, decrypt),
});

/**
 * Get active holidays (end_date >= today) for date computation (from cache).
 * "today" is computed in the configured timezone.
 */
export const getActiveHolidays = async (): Promise<Holiday[]> => {
  const today = todayInTz(settings.timezone);
  const all = await holidays.getAll();
  return filter((h: Holiday) => h.end_date >= today)(all);
};
