/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 * The audience and the write rule come from the holiday record.
 */

import type { Holiday, HolidayInput } from "#db/holidays.ts";
import { holidayInput, readDates } from "#routes/admin/holiday-input.ts";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { withWriteName } from "#shared/rest/crud-parsers.ts";
import { recordApi } from "#shared/rest/record-api.ts";
import { okResult } from "#shared/result.ts";

/** JSON body accepted by POST /api/admin/holidays */
export type CreateHolidayBody = {
  name: string;
  start_date: string;
  end_date: string;
};

/** JSON body accepted by PUT /api/admin/holidays/:holidayId */
export type UpdateHolidayBody = Partial<CreateHolidayBody>;

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

export const holidayApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.holidays,
  Holiday,
  HolidayInput
>(holidayRecord, {
  toCreateInput: (body) => holidayInputFrom(body, null),
  toUpdateInput: (body, existing) => holidayInputFrom(body, existing),
});
