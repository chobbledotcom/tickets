/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 */

import { type Holiday, type HolidayInput, holidays } from "#db/holidays.ts";
import { holidayInput, readDates } from "#routes/admin/holiday-input.ts";
import { validateDateRange } from "#routes/admin/holidays.ts";
import { OWNER_API } from "#routes/auth.ts";
import { invalidApiValueField } from "#shared/catalog-fields/definition.ts";
import { holidayFields } from "#shared/catalog-fields/fields.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
// jscpd:ignore-start
import {
  type FieldRefusal,
  requireEntityName,
} from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
// jscpd:ignore-end

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

/** The field-value guard both mappers run first: a supplied value that fails
 *  its field check names the field in the refusal. The create mapper answers
 *  the field error first. The update mapper uses the same order, so the same
 *  bad body gets the same message on both surfaces. */
const refuseInvalidFieldValue: FieldRefusal = (body) => {
  const invalid = invalidApiValueField(holidayFields, body);
  if (invalid === null) return null;
  return errorResult(`${invalid} has an invalid value`);
};

/** The shared mapper spine: the field guard, then the name, then the date
 *  reads. The two mappers hand it their existing row for the update
 *  fallbacks, or null on create. */
const holidayInputFrom = (
  body: Record<string, unknown>,
  existing: { end_date: string; name: string; start_date: string } | null,
): Result<HolidayInput> => {
  const guard = refuseInvalidFieldValue(body);
  if (guard) return guard;
  const name = requireEntityName(body, existing?.name ?? null);
  if (!name.ok) return name;
  const dates = readDates(body, existing);
  if (!dates.ok) return dates;
  return okResult(holidayInput(name.value, dates.value));
};

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

  toCreateInput: (body) => holidayInputFrom(body, null),

  toUpdateInput: (body, existing) => holidayInputFrom(body, existing),
  validate: validateDateRange,
});
