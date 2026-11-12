/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 */

import { type Holiday, type HolidayInput, holidays } from "#db/holidays.ts";
import { holidayInput, readDates } from "#routes/admin/holiday-input.ts";
import { validateDateRange } from "#routes/admin/holidays.ts";
import { OWNER_API } from "#routes/auth.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import { withWriteName } from "#shared/rest/crud-parsers.ts";
import { okResult } from "#shared/result.ts";

/** JSON body accepted by POST /api/admin/holidays */
export type CreateHolidayBody = {
  name: string;
  start_date: string;
  end_date: string;
};

/** JSON body accepted by PUT /api/admin/holidays/:holidayId */
export type UpdateHolidayBody = Partial<CreateHolidayBody>;

// DELETE /api/admin/holidays/:holidayId takes the shared DeleteBody the
// crud-parsers module exports.

/** One holiday write body after the resource table's schema validates it. */
type HolidayWriteBody = {
  end_date?: string | undefined;
  name?: string | undefined;
  start_date?: string | undefined;
};

/** The shared mapper spine: the name, then the date reads. The two mappers
 *  hand it their existing row for the update fallbacks, or null on create. */
const holidayInputFrom = withWriteName<
  HolidayWriteBody,
  { end_date: string; name: string; start_date: string },
  HolidayInput
>((name, body, existing) => {
  const dates = readDates(body, existing);
  if (!dates.ok) return dates;
  return okResult(holidayInput(name, dates.value));
});

export const holidayApiRoutes = defineCrudApi<
  typeof ADMIN_API_RESOURCES.holidays,
  Holiday,
  HolidayInput
>(ADMIN_API_RESOURCES.holidays, {
  getAll: holidays.getAll,
  nameField: "name",
  // The dashboard's holiday routes are owner-only, because that is what
  // `holidays` declares. The JSON API matches, so a manager cannot mutate a
  // holiday through the API either.
  policy: OWNER_API,
  table: holidays.table,

  toCreateInput: (body) => holidayInputFrom(body, null),

  toUpdateInput: (body, existing) => holidayInputFrom(body, existing),
  validate: validateDateRange,
});
