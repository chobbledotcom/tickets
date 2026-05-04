/**
 * Holidays table operations
 */

import { filter } from "#fp";
import { registerCache } from "#shared/cache-registry.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { queryAndMap } from "#shared/db/query.ts";
import { settings } from "#shared/db/settings.ts";
import { col, defineTable, withCacheInvalidation } from "#shared/db/table.ts";
import { requestCache } from "#shared/request-cache.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { Holiday } from "#shared/types.ts";

/** Holiday input fields for create/update (camelCase) */
export type HolidayInput = {
  name: string;
  startDate: string;
  endDate: string;
};

/** Raw holidays table with CRUD operations — name is encrypted, dates are plaintext */
const rawHolidaysTable = defineTable<Holiday, HolidayInput>({
  name: "holidays",
  primaryKey: "id",
  schema: {
    end_date: col.simple<string>(),
    id: col.generated<number>(),
    name: col.encrypted<string>(encrypt, decrypt),
    start_date: col.simple<string>(),
  },
});

/** Execute a query and decrypt the resulting holiday rows */
const queryHolidays = queryAndMap<Holiday, Holiday>((row) =>
  rawHolidaysTable.fromDb(row),
);

const holidaysCache = requestCache(() =>
  queryHolidays("SELECT * FROM holidays ORDER BY start_date ASC"),
);

registerCache(() => ({ entries: holidaysCache.size(), name: "holidays" }));

/** Invalidate the holidays cache (for testing or after writes). */
export const invalidateHolidaysCache = (): void => {
  holidaysCache.invalidate();
};

/** Holidays table with CRUD operations — writes auto-invalidate the cache */
export const holidaysTable = withCacheInvalidation(
  rawHolidaysTable,
  invalidateHolidaysCache,
);

/**
 * Get all holidays, decrypted, ordered by start_date (from cache)
 */
export const getAllHolidays = (): Promise<Holiday[]> => holidaysCache.getAll();

/**
 * Get active holidays (end_date >= today) for date computation (from cache).
 * "today" is computed in the configured timezone.
 */
export const getActiveHolidays = async (): Promise<Holiday[]> => {
  const today = todayInTz(settings.timezone);
  const holidays = await holidaysCache.getAll();
  return filter((h: Holiday) => h.end_date >= today)(holidays);
};
