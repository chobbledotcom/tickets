/**
 * Admin holiday management routes - owner only
 */

import { getAllHolidays, type HolidayInput, holidaysTable } from "#lib/db/holidays.ts";
import { defineResource } from "#lib/rest/resource.ts";
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
    input.endDate < input.startDate
      ? "End date must be on or after the start date"
      : null,
  );

/** Holidays resource for REST create/update operations */
const holidaysResource = defineResource({
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
  resource: holidaysResource,
  renderList: adminHolidaysPage,
  renderNew: adminHolidayNewPage,
  renderEdit: adminHolidayEditPage,
  renderDelete: adminHolidayDeletePage,
  getName: (h) => h.name,
  deleteConfirmError: "Holiday name does not match. Please type the exact name to confirm deletion.",
});

/** Holiday routes */
export const holidaysRoutes = defineRoutes({
  "GET /admin/holidays": crud.listGet,
  "GET /admin/holiday/new": crud.newGet,
  "POST /admin/holiday": crud.createPost,
  "GET /admin/holiday/:id/edit": (request, { id }) => crud.editGet(request, id),
  "POST /admin/holiday/:id/edit": (request, { id }) => crud.editPost(request, id),
  "GET /admin/holiday/:id/delete": (request, { id }) => crud.deleteGet(request, id),
  "POST /admin/holiday/:id/delete": (request, { id }) => crud.deletePost(request, id),
});
