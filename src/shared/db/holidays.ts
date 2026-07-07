/**
 * Holidays table operations
 */

import { filter } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { settings } from "#shared/db/settings.ts";
import { col, defineCachedListTable } from "#shared/db/table.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { Holiday } from "#shared/types.ts";

/** Holiday input fields for create/update (camelCase) */
export type HolidayInput = {
  name: string;
  startDate: string;
  endDate: string;
};

/** Cached holidays table — name is encrypted, dates are plaintext; writes
 * auto-invalidate the cache. */
const holidays = defineCachedListTable<Holiday, HolidayInput>({
  name: "holidays",
  orderBy: "start_date ASC",
  primaryKey: "id",
  schema: {
    end_date: col.simple<string>(),
    id: col.generated<number>(),
    name: col.encrypted(encrypt, decrypt),
    start_date: col.simple<string>(),
  },
});

/** Holidays table with CRUD operations — writes auto-invalidate the cache */
export const holidaysTable = holidays.table;

/** Invalidate the holidays cache (for testing or after writes). */
export const invalidateHolidaysCache = (): void => {
  holidays.invalidate();
};

/**
 * Get all holidays, decrypted, ordered by start_date (from cache)
 */
export const getAllHolidays = (): Promise<Holiday[]> => holidays.getAll();

/**
 * Get active holidays (end_date >= today) for date computation (from cache).
 * "today" is computed in the configured timezone.
 */
export const getActiveHolidays = async (): Promise<Holiday[]> => {
  const today = todayInTz(settings.timezone);
  const all = await holidays.getAll();
  return filter((h: Holiday) => h.end_date >= today)(all);
};
