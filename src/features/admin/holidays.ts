/**
 * Admin holiday management routes - owner only. Both doors read the one
 * holiday record declaration.
 */

import type { HolidayInput } from "#db/holidays.ts";
import { t } from "#i18n";
import {
  crudRoutes,
  defineAdminRoutes,
  entityTabRoutes,
} from "#routes/admin/route-tables.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import {
  applyDemoOverrides,
  HOLIDAY_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { parseDateStringOrThrow } from "#shared/validation/date-string.ts";
import {
  adminHolidaysPage,
  getHolidayPages,
} from "#templates/admin/holidays.tsx";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { holidayPage } from "./holiday-page.ts";

/** Extract holiday input from validated form values */
type HolidayFormValues = FormValues<ReturnType<typeof getHolidayForm>>;

const extractHolidayInput = (values: HolidayFormValues): HolidayInput => ({
  endDate: parseDateStringOrThrow(
    values.end_date,
    "the holiday form's end date",
  ),
  name: values.name,
  startDate: parseDateStringOrThrow(
    values.start_date,
    "the holiday form's start date",
  ),
});

const pages = recordPages(holidayRecord, {
  form: getHolidayForm(),
  identifierLabel: t("holidays.name_label"),
  preprocessForm: (form) => applyDemoOverrides(form, HOLIDAY_DEMO_FIELDS),
  renderDelete: (...args) => getHolidayPages().deletePage(...args),
  renderEditError: holidayPage.renderEditError,
  renderList: adminHolidaysPage,
  renderNew: (...args) => getHolidayPages().newPage(...args),
  singular: "Holiday",
  toInput: extractHolidayInput,
});

export const adminHandlers = defineAdminRoutes({
  ...crudRoutes(adminPattern("holidays"), pages),
  ...entityTabRoutes(adminPattern("holiday"), holidayPage),
});
