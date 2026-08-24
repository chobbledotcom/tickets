/**
 * Holidays table operations
 */

import { decrypt, encrypt } from "#crypto/encryption.ts";
import { idAndEncryptedNameSchema } from "#db/common-schema.ts";
import { settings } from "#db/settings.ts";
import { col, defineCachedListTable } from "#db/table.ts";
import { filter } from "#fp";
import { todayInTz } from "#shared/timezone.ts";
import type { Holiday } from "#types";

/** Holiday input fields for create/update (camelCase) */
export type HolidayInput = {
  name: string;
  startDate: string;
  endDate: string;
};

/** Cached holidays table — name is encrypted, dates are plaintext; writes
 * auto-invalidate the cache. */
export const holidays = defineCachedListTable<Holiday, HolidayInput>({
  name: "holidays",
  orderBy: "start_date ASC",
  primaryKey: "id",
  schema: {
    ...idAndEncryptedNameSchema(encrypt, decrypt),
    end_date: col.simple<string>(),
    start_date: col.simple<string>(),
  },
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
