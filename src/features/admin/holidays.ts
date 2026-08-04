/**
 * Admin holiday management routes - owner only
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { crudRoutes, entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes } from "#routes/router.ts";
import { type HolidayInput, holidays } from "#shared/db/holidays.ts";
import {
  HOLIDAY_DEMO_FIELDS,
  wrapResourceForDemo,
} from "#shared/demo/overrides.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import {
  adminHolidaysPage,
  getHolidayPages,
} from "#templates/admin/holidays.tsx";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { holidayPage } from "./holiday-page.ts";

/* jscpd:ignore-end */

/** Extract holiday input from validated form values */
type HolidayFormValues = FormValues<ReturnType<typeof getHolidayForm>>;

const extractHolidayInput = (values: HolidayFormValues): HolidayInput => ({
  endDate: values.end_date,
  name: values.name,
  startDate: values.start_date,
});

/** Validate end_date >= start_date */
export const validateDateRange = (
  input: HolidayInput,
): Promise<string | null> =>
  Promise.resolve(
    input.endDate < input.startDate ? t("error.end_date_before_start") : null,
  );

/** Holidays resource for REST create/update operations */
const holidaysResource = wrapResourceForDemo(
  defineNamedResource({
    form: getHolidayForm(),
    nameField: "name",
    table: holidays.table,
    toInput: extractHolidayInput,
    validate: validateDateRange,
  }),
  HOLIDAY_DEMO_FIELDS,
);

export const holidaysCrud = createOwnerCrudHandlers({
  getAll: holidays.getAll,
  getName: (h) => h.name,
  getRowPath: (holiday) => holidayPage.path(holiday.id),
  listPath: "/admin/holidays",
  operations: holidaysResource,
  renderDelete: (...args) => getHolidayPages().deletePage(...args),
  renderEditError: holidayPage.renderEditError,
  renderList: adminHolidaysPage,
  renderNew: (...args) => getHolidayPages().newPage(...args),
  singular: "Holiday",
});

export const adminHandlers = defineRoutes({
  ...crudRoutes("/admin/holidays", holidaysCrud),
  ...entityTabRoutes("/admin/holidays", holidayPage),
});
