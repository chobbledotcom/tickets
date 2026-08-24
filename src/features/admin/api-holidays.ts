/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 */

import { type HolidayInput, holidays } from "#db/holidays.ts";
import { isNotNullish } from "#fp";
import { validateDateRange } from "#routes/admin/holidays.ts";
import { OWNER_API } from "#routes/auth.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  type DeleteBody,
  parseUpdateName,
  requireStrings,
} from "#shared/rest/crud-parsers.ts";
import { okResult } from "#shared/result.ts";
import type { Holiday } from "#types";

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
  getAll: holidays.getAll,
  name: "holidays",
  nameField: "name",
  // The dashboard's holiday routes are owner-only, because that is what
  // `holidays` declares. The JSON API matches, so a manager cannot mutate a
  // holiday through the API either.
  policy: OWNER_API,
  singular: "Holiday",
  table: holidays.table,

  toCreateInput: (body) => {
    const required = requireStrings(body, ["name", "start_date", "end_date"]);
    if (!required.ok) return required;
    const { end_date: endDate, name, start_date: startDate } = required.value;
    return okResult({ endDate, name, startDate });
  },

  toUpdateInput: (body, existing) => {
    const nameParsed = parseUpdateName(body, existing.name);
    if (!nameParsed.ok) return nameParsed;
    const trimmedFieldOrFallback = (key: string, fallback: string) =>
      isNotNullish(body[key]) ? String(body[key]).trim() : fallback;
    return okResult({
      endDate: trimmedFieldOrFallback("end_date", existing.end_date),
      name: nameParsed.value,
      startDate: trimmedFieldOrFallback("start_date", existing.start_date),
    });
  },
  validate: validateDateRange,
});
