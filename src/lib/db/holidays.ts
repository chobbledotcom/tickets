/**
 * Holidays table operations
 */

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

/** Holidays table with CRUD operations — name is encrypted, dates are plaintext */
export const holidaysTable = defineTable<Holiday, HolidayInput>({
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
const queryHolidays = queryAndMap<Holiday, Holiday>((row) => holidaysTable.fromDb(row));

/**
 * Get all holidays, decrypted, ordered by start_date
 */
export const getAllHolidays = (): Promise<Holiday[]> =>
  queryHolidays("SELECT * FROM holidays ORDER BY start_date ASC");

/**
 * Get active holidays (end_date >= today) for date computation.
 * "today" is computed in the configured timezone.
 */
export const getActiveHolidays = (): Promise<Holiday[]> => {
  const tz = getTz();
  return queryHolidays({
    sql: "SELECT * FROM holidays WHERE end_date >= ? ORDER BY start_date ASC",
    args: [todayInTz(tz)],
  });
};
