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

<<<<<<< HEAD
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
=======
/** Handle GET /admin/holidays */
const handleHolidaysGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const holidays = await getAllHolidays();
    return htmlResponse(adminHolidaysPage(holidays, session));
  });

/** Handle GET /admin/holiday/new */
const handleHolidayNewGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, (session) =>
    htmlResponse(adminHolidayNewPage(session)),
  );

/** Handle POST /admin/holiday (create) */
const handleHolidayCreate = (request: Request) =>
  withOwnerAuthForm(request, async (session, form) => {
    const result = await holidaysResource.create(form);
    if (result.ok) {
      await logActivity(`Holiday '${String(form.get("name"))}' created`);
      return redirect("/admin/holidays");
    }
    return htmlResponse(adminHolidayNewPage(session, result.error), 400);
  });

/** Fetch holiday by ID or return 404. Calls handler if found. */
const withHoliday = async (
  holidayId: number,
  handler: (holiday: Holiday) => Response | Promise<Response>,
): Promise<Response> => {
  const holiday = await holidaysTable.findById(holidayId);
  return holiday ? handler(holiday) : notFoundResponse();
};

/** Owner GET route that fetches a holiday or returns 404 */
const holidayPage = (
  renderPage: (holiday: Holiday, session: AdminSession, error?: string) => string,
) =>
  (request: Request, params: { id: number }): Promise<Response> =>
    requireOwnerOr(request, (session) =>
      withHoliday(params.id, (holiday) => htmlResponse(renderPage(holiday, session))));

/** Handle GET /admin/holiday/:id/edit */
const handleHolidayEditGet = holidayPage(adminHolidayEditPage);

/** Render holiday error page or 404 */
const holidayErrorPage = (
  id: number,
  renderPage: (holiday: Holiday, session: AdminSession, error?: string) => string,
  session: AdminSession,
  error: string,
): Promise<Response> =>
  withHoliday(id, (holiday) => htmlResponse(renderPage(holiday, session, error), 400));

/** Handle POST /admin/holiday/:id/edit (update) */
const handleHolidayEditPost = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const validation = validateForm(form, holidayFields);
    if (!validation.valid) {
      return holidayErrorPage(id, adminHolidayEditPage, session, validation.error);
    }

    const input = extractHolidayInput(validation.values);
    const rangeError = await validateDateRange(input);
    if (rangeError) {
      return holidayErrorPage(id, adminHolidayEditPage, session, rangeError);
    }

    const updated = await holidaysTable.update(id, input);
    if (!updated) return notFoundResponse();

    await logActivity(`Holiday '${String(form.get("name"))}' updated`);
    return redirect("/admin/holidays");
  });

/** Handle GET /admin/holiday/:id/delete */
const handleHolidayDeleteGet = holidayPage(adminHolidayDeletePage);

/** Handle POST /admin/holiday/:id/delete */
const handleHolidayDeletePost = (
  request: Request,
  params: { id: number },
): Promise<Response> =>
  withOwnerAuthForm(request, (session, form) =>
    withHoliday(params.id, async (holiday) => {
      const confirmIdentifier = String(form.get("confirm_identifier"));
      if (!verifyIdentifier(holiday.name, confirmIdentifier)) {
        return holidayErrorPage(
          params.id,
          adminHolidayDeletePage,
          session,
          "Holiday name does not match. Please type the exact name to confirm deletion.",
        );
      }

      await holidaysTable.deleteById(params.id);
      await logActivity(`Holiday '${holiday.name}' deleted`);
      return redirect("/admin/holidays");
    }),
  );

/** Holiday routes */
export const holidaysRoutes = defineRoutes({
  "GET /admin/holidays": handleHolidaysGet,
  "GET /admin/holiday/new": handleHolidayNewGet,
  "POST /admin/holiday": handleHolidayCreate,
  "GET /admin/holiday/:id/edit": handleHolidayEditGet,
  "POST /admin/holiday/:id/edit": handleHolidayEditPost,
  "GET /admin/holiday/:id/delete": handleHolidayDeleteGet,
  "POST /admin/holiday/:id/delete": handleHolidayDeletePost,
>>>>>>> 8aba18c (Eliminate route table wrapper lambdas with direct handler references (#323))
});
