/**
 * Admin holiday management routes - owner only. Both doors read the one
 * holiday record declaration.
 */

import { defineAdminRoutes, recordRoutes } from "#routes/admin/route-tables.ts";
import {
  applyDemoOverrides,
  HOLIDAY_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import { holidayRecord } from "#shared/records/holidays.ts";
import { formInput } from "#shared/rest/field-reads.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import {
  adminHolidaysPage,
  getHolidayPages,
} from "#templates/admin/holidays.tsx";
import { getHolidayForm } from "#templates/fields/admin.ts";
import { holidayPage } from "./holiday-page.ts";

const pages = recordPages(holidayRecord, {
  form: getHolidayForm(),
  preprocessForm: (form) => applyDemoOverrides(form, HOLIDAY_DEMO_FIELDS),
  renderDelete: (...args) => getHolidayPages().deletePage(...args),
  renderEditError: holidayPage.renderEditError,
  renderList: adminHolidaysPage,
  renderNew: (...args) => getHolidayPages().newPage(...args),
  toInput: formInput(HOLIDAY_FIELDS),
});

export const adminHandlers = defineAdminRoutes({
  ...recordRoutes("holidays", pages, holidayPage),
});
