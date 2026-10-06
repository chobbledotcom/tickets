/**
 * Admin JSON API routes for holidays — accessible via API key or cookie+CSRF.
 * The input mapping rides the shared holiday field set, the same fields the
 * page form declares, so both surfaces parse one set of facts.
 */

import { type Holiday, type HolidayInput, holidays } from "#db/holidays.ts";
import { validateDateRange } from "#routes/admin/holidays.ts";
import { OWNER_API } from "#routes/auth.ts";
import {
  invalidApiValueField,
  projectCatalogFields,
} from "#shared/catalog-fields/definition.ts";
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

/** Map one JSON body to the holiday input. Create requires all three fields
 *  and names the first missing one. Update merges the supplied fields onto the
 *  stored ones. A supplied date that is not text is refused. The stored values
 *  are date strings, and a coerced number or object stores a range that nobody
 *  typed. */
const toHolidayInput = (
  body: Record<string, unknown>,
  existing: Holiday | null,
): Result<HolidayInput> => {
  const invalid = invalidApiValueField(holidayFields, body);
  if (invalid) return errorResult(`${invalid} has an invalid value`);

  if (existing === null) {
    const required = requireStrings(body, ["name", "start_date", "end_date"]);
    if (!required.ok) return required;
    const { end_date: endDate, name, start_date: startDate } = required.value;
    return okResult({ endDate, name, startDate });
  }

  const name = parseUpdateName(body, existing.name);
  if (!name.ok) return name;
  // The stored row always carries both dates, so the storedApi projection has
  // already supplied them. The fallbacks only satisfy the optional projection
  // type.
  const merged = {
    ...projectCatalogFields(holidayFields, "storedApi", existing),
    ...projectCatalogFields(holidayFields, "api", body),
  };
  return okResult({
    endDate: merged.endDate ?? existing.end_date,
    name: name.value,
    startDate: merged.startDate ?? existing.start_date,
  });
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
  toCreateInput: (body) => toHolidayInput(body, null),
  toUpdateInput: (body, existing) => toHolidayInput(body, existing),
  validate: validateDateRange,
});
