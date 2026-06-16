/**
 * Admin holiday management routes - owner only
 */

import { t } from "#i18n";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import {
  getAllHolidays,
  type HolidayInput,
  holidaysTable,
} from "#shared/db/holidays.ts";
import { HOLIDAY_DEMO_FIELDS, wrapResourceForDemo } from "#shared/demo.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import {
  adminHolidayDeletePage,
  adminHolidayEditPage,
  adminHolidayNewPage,
  adminHolidaysPage,
} from "#templates/admin/holidays.tsx";
import { getHolidayFields } from "#templates/fields.ts";

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
    input.endDate < input.startDate ? t("error.end_date_before_start") : null,
  );

/** Holidays resource for REST create/update operations */
const holidaysResource = defineNamedResource({
  fields: getHolidayFields(),
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
