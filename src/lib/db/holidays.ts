/**
 * Holidays table operations
 */

import { collectionCache, filter } from "#fp";
import { decrypt, encrypt } from "#lib/crypto.ts";
import { getTz } from "#lib/config.ts";
import { todayInTz } from "#lib/timezone.ts";
import { queryAndMap } from "#lib/db/query.ts";
import { col, defineTable } from "#lib/db/table.ts";
import type { Holiday } from "#lib/types.ts";

/** Holiday input fields for create/update (camelCase) */
export type HolidayInput = {
  name: string;
  startDate: string;
  endDate: string;
};

/**
 * In-memory holidays cache. Loads all holidays in a single query and
 * serves subsequent reads from memory until the TTL expires or a
 * write invalidates the cache.
 */
export const HOLIDAYS_CACHE_TTL_MS = 60_000;

/** Raw holidays table with CRUD operations — name is encrypted, dates are plaintext */
const rawHolidaysTable = defineTable<Holiday, HolidayInput>({
  name: "holidays",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    start_date: col.simple<string>(),
    name: col.encrypted<string>(encrypt, decrypt),
    end_date: col.simple<string>(),
  },
});

/** Execute a query and decrypt the resulting holiday rows */
const queryHolidays = queryAndMap<Holiday, Holiday>((row) => rawHolidaysTable.fromDb(row));

const holidaysCache = collectionCache(
  () => queryHolidays("SELECT * FROM holidays ORDER BY start_date ASC"),
  HOLIDAYS_CACHE_TTL_MS,
);

/** Invalidate the holidays cache (for testing or after writes). */
export const invalidateHolidaysCache = (): void => {
  holidaysCache.invalidate();
};

/** Holidays table with CRUD operations — writes auto-invalidate the cache */
export const holidaysTable: typeof rawHolidaysTable = {
  ...rawHolidaysTable,
  insert: async (input) => {
    const result = await rawHolidaysTable.insert(input);
    invalidateHolidaysCache();
    return result;
  },
  update: async (id, input) => {
    const result = await rawHolidaysTable.update(id, input);
    invalidateHolidaysCache();
    return result;
  },
  deleteById: async (id) => {
    await rawHolidaysTable.deleteById(id);
    invalidateHolidaysCache();
  },
};

/**
 * Get all holidays, decrypted, ordered by start_date (from cache)
 */
export const getAllHolidays = (): Promise<Holiday[]> =>
  holidaysCache.getAll();

/**
 * Get active holidays (end_date >= today) for date computation (from cache).
 * "today" is computed in the configured timezone.
 */
export const getActiveHolidays = async (): Promise<Holiday[]> => {
  const today = todayInTz(getTz());
  const holidays = await holidaysCache.getAll();
  return filter((h: Holiday) => h.end_date >= today)(holidays);
};
