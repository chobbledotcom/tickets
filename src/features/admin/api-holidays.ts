/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 * The input mapping rides the shared holiday field set, the same fields the
 * page form declares, so both surfaces parse one set of facts.
 */

import { type Holiday, type HolidayInput, holidays } from "#db/holidays.ts";
import { validateDateRange } from "#routes/admin/holidays.ts";
import { OWNER_API } from "#routes/auth.ts";
import { invalidApiValueField } from "#shared/catalog-fields/definition.ts";
import { holidayFields } from "#shared/catalog-fields/fields.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import { parseUpdateName, requireStrings } from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

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
const refuseInvalidFieldValue = (
  body: Record<string, unknown>,
): Result<never> | null => {
  const invalid = invalidApiValueField(holidayFields, body);
  return invalid ? errorResult(`${invalid} has an invalid value`) : null;
};

/** Create requires all three fields and names the first missing one. */
const createFromRequiredStrings = (
  body: Record<string, unknown>,
): Result<HolidayInput> => {
  const required = requireStrings(body, ["name", "start_date", "end_date"]);
  if (!required.ok) return required;
  const { end_date: endDate, name, start_date: startDate } = required.value;
  return okResult({ endDate, name, startDate });
};

const toHolidayCreateInput = (body: Record<string, unknown>) =>
  refuseInvalidFieldValue(body) ?? createFromRequiredStrings(body);

/** Map an update body onto the stored holiday: supplied fields win, absent
 *  ones keep the stored value, so a partial update never blanks a date. */
const updateOntoStored = (
  body: Record<string, unknown>,
  existing: Holiday,
): Result<HolidayInput> => {
  const name = parseUpdateName(body, existing.name);
  if (!name.ok) return name;
  return okResult({
    endDate:
      typeof body.end_date === "string" ? body.end_date : existing.end_date,
    name: name.value,
    startDate:
      typeof body.start_date === "string"
        ? body.start_date
        : existing.start_date,
  });
};

const toHolidayUpdateInput = (
  body: Record<string, unknown>,
  existing: Holiday,
) => refuseInvalidFieldValue(body) ?? updateOntoStored(body, existing);

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
  toCreateInput: toHolidayCreateInput,
  toUpdateInput: toHolidayUpdateInput,
  validate: validateDateRange,
});
