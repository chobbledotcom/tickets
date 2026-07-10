/**
 * Admin holiday management routes - owner only
 */

import { t } from "#i18n";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { type HolidayInput, holidays } from "#shared/db/holidays.ts";
import {
  HOLIDAY_DEMO_FIELDS,
  wrapResourceForDemo,
} from "#shared/demo/overrides.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { adminHolidaysPage, holidayPages } from "#templates/admin/holidays.tsx";
import { getHolidayFields } from "#templates/fields/admin.ts";

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
  table: holidays.table,
  toInput: extractHolidayInput,
  validate: validateDateRange,
});

export const holidaysCrud = createOwnerCrudHandlers({
  getAll: holidays.getAll,
  getName: (h) => h.name,
  listPath: "/admin/holidays",
  renderDelete: holidayPages.deletePage,
  renderEdit: holidayPages.editPage,
  renderList: adminHolidaysPage,
  renderNew: holidayPages.newPage,
  resource: wrapResourceForDemo(holidaysResource, HOLIDAY_DEMO_FIELDS),
  singular: "Holiday",
});
