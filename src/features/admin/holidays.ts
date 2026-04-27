/**
 * Admin holiday management routes - owner only
 */

import {
  getAllHolidays,
  type HolidayInput,
  holidaysTable,
} from "#lib/db/holidays.ts";
import { HOLIDAY_DEMO_FIELDS, wrapResourceForDemo } from "#lib/demo.ts";
import { defineNamedResource } from "#lib/rest/resource.ts";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import {
  adminHolidayDeletePage,
  adminHolidayEditPage,
  adminHolidayNewPage,
  adminHolidaysPage,
} from "#templates/admin/holidays.tsx";
import { holidayFields } from "#templates/fields.ts";

/** Extract holiday input from validated form values */
const extractHolidayInput = (
  values: Record<string, string | number | null>,
): HolidayInput => ({
  endDate: String(values.end_date),
  name: String(values.name),
  startDate: String(values.start_date),
});

/** Validate end_date >= start_date */
export const validateDateRange = (
  input: HolidayInput,
): Promise<string | null> =>
  Promise.resolve(
    input.endDate < input.startDate
      ? "End date must be on or after the start date"
      : null,
  );

/** Holidays resource for REST create/update operations */
const holidaysResource = defineNamedResource({
  fields: holidayFields,
  nameField: "name",
  table: holidaysTable,
  toInput: extractHolidayInput,
  validate: validateDateRange,
});

const crud = createOwnerCrudHandlers({
  getAll: getAllHolidays,
  getName: (h) => h.name,
  listPath: "/admin/holidays",
  renderDelete: adminHolidayDeletePage,
  renderEdit: adminHolidayEditPage,
  renderList: adminHolidaysPage,
  renderNew: adminHolidayNewPage,
  resource: wrapResourceForDemo(holidaysResource, HOLIDAY_DEMO_FIELDS),
  singular: "Holiday",
});

/** Holiday routes */
export const holidaysRoutes = crud.routes;
