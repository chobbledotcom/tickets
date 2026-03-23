/**
 * Admin holiday management routes - owner only
 */

import { t } from "#i18n";
import {
  getAllHolidays,
  type HolidayInput,
  holidaysTable,
} from "#lib/db/holidays.ts";
import { HOLIDAY_DEMO_FIELDS, wrapResourceForDemo } from "#lib/demo.ts";
import { defineNamedResource } from "#lib/rest/resource.ts";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { defineRoutes } from "#routes/router.ts";
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
  name: String(values.name),
  startDate: String(values.start_date),
  endDate: String(values.end_date),
});

/** Validate end_date >= start_date */
const validateDateRange = (input: HolidayInput): Promise<string | null> =>
  Promise.resolve(
    input.endDate < input.startDate ? t("error.end_date_before_start") : null,
  );

/** Holidays resource for REST create/update operations */
const holidaysResource = defineNamedResource({
  table: holidaysTable,
  fields: holidayFields,
  toInput: extractHolidayInput,
  nameField: "name",
  validate: validateDateRange,
});

const crud = createOwnerCrudHandlers({
  singular: "Holiday",
  listPath: "/admin/holidays",
  getAll: getAllHolidays,
  resource: wrapResourceForDemo(holidaysResource, HOLIDAY_DEMO_FIELDS),
  renderList: adminHolidaysPage,
  renderNew: adminHolidayNewPage,
  renderEdit: adminHolidayEditPage,
  renderDelete: adminHolidayDeletePage,
  getName: (h) => h.name,
  deleteConfirmError: t("error.holiday_name_mismatch"),
});

/** Holiday routes */
export const holidaysRoutes = defineRoutes({
  "GET /admin/holidays": crud.listGet,
  "GET /admin/holiday/new": crud.newGet,
  "POST /admin/holiday": crud.createPost,
  "GET /admin/holiday/:id/edit": crud.editGet,
  "POST /admin/holiday/:id/edit": crud.editPost,
  "GET /admin/holiday/:id/delete": crud.deleteGet,
  "POST /admin/holiday/:id/delete": crud.deletePost,
});
