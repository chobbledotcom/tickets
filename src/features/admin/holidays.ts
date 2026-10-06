/**
 * Admin holiday management routes - owner only
 */

import { type HolidayInput, holidays } from "#db/holidays.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import { crudRoutes, entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import { holidayFields } from "#shared/catalog-fields/fields.ts";
import {
  HOLIDAY_DEMO_FIELDS,
  wrapResourceForDemo,
} from "#shared/demo/overrides.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { defineResource } from "#shared/rest/resource.ts";
import {
  adminHolidaysPage,
  getHolidayPages,
} from "#templates/admin/holidays.tsx";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { holidayPage } from "./holiday-page.ts";

/* jscpd:ignore-end */

/** Extract holiday input from validated form values. The mapping rides the
 *  shared holiday field set, the same fields the JSON API declares. */
type HolidayFormValues = FormValues<ReturnType<typeof getHolidayForm>>;

const extractHolidayInput = (values: HolidayFormValues): HolidayInput =>
  projectCatalogFields(holidayFields, "form", values);

/** Validate end_date >= start_date */
export const validateDateRange = (
  input: HolidayInput,
): Promise<string | null> =>
  Promise.resolve(
    input.endDate < input.startDate ? t("error.end_date_before_start") : null,
  );

/** Holidays resource for REST create/update operations */
const holidaysResource = wrapResourceForDemo(
  defineResource({
    form: getHolidayForm(),
    table: holidays.table,
    toInput: extractHolidayInput,
    validate: validateDateRange,
  }),
  HOLIDAY_DEMO_FIELDS,
);

export const holidaysCrud = createCrudHandlers({
  getAll: holidays.getAll,
  getName: (h) => h.name,
  getRowPath: (holiday) => holidayPage.path(holiday.id),
  list: "holidays",
  operations: holidaysResource,
  renderDelete: (...args) => getHolidayPages().deletePage(...args),
  renderEditError: holidayPage.renderEditError,
  renderList: adminHolidaysPage,
  renderNew: (...args) => getHolidayPages().newPage(...args),
  singular: "Holiday",
});

export const adminHandlers = defineRoutes({
  ...crudRoutes(adminPattern("holidays"), holidaysCrud),
  ...entityTabRoutes(adminPattern("holiday"), holidayPage),
});
