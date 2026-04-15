/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 */

import {
  getAllHolidays,
  type HolidayInput,
  holidaysTable,
} from "#lib/db/holidays.ts";
import {
  type DeleteBody,
  defineCrudApi,
  parseUpdateName,
  requireString,
} from "#lib/rest/crud-api.ts";
import type { Holiday } from "#lib/types.ts";
import { validateDateRange } from "#routes/admin/holidays.ts";

/** JSON body accepted by POST /api/admin/holidays */
export type CreateHolidayBody = {
  name: string;
  start_date: string;
  end_date: string;
};

/** JSON body accepted by PUT /api/admin/holidays/:holidayId */
export type UpdateHolidayBody = Partial<CreateHolidayBody>;

/** JSON body accepted by DELETE /api/admin/holidays/:holidayId */
export type DeleteHolidayBody = DeleteBody;

export const holidayApiRoutes = defineCrudApi<Holiday, HolidayInput>({
  getAll: getAllHolidays,
  name: "holidays",
  nameField: "name",
  singular: "Holiday",
  table: holidaysTable,

  toCreateInput: (body) => {
    const name = requireString(body, "name");
    if (!name) return { error: "name is required", ok: false };
    const startDate = requireString(body, "start_date");
    if (!startDate) return { error: "start_date is required", ok: false };
    const endDate = requireString(body, "end_date");
    if (!endDate) return { error: "end_date is required", ok: false };
    return { input: { endDate, name, startDate }, ok: true };
  },

  toUpdateInput: (body, existing) => {
    const nameParsed = parseUpdateName(body, existing.name);
    if (!nameParsed.ok) return nameParsed;
    const str = (key: string, fallback: string) =>
      body[key] != null ? String(body[key]).trim() : fallback;
    return {
      input: {
        endDate: str("end_date", existing.end_date),
        name: nameParsed.name,
        startDate: str("start_date", existing.start_date),
      },
      ok: true,
    };
  },
  validate: validateDateRange,
});
