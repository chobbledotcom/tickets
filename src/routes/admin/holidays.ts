/**
 * Admin holiday management routes - owner only
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { getAllHolidays, type HolidayInput, holidaysTable } from "#lib/db/holidays.ts";
import { validateForm } from "#lib/forms.tsx";
import { defineResource } from "#lib/rest/resource.ts";
import type { AdminSession, Holiday } from "#lib/types.ts";
import { defineRoutes, type RouteHandlerFn } from "#routes/router.ts";
import { verifyIdentifier } from "#routes/admin/utils.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import {
  adminHolidayDeletePage,
  adminHolidayEditPage,
  adminHolidayNewPage,
  adminHolidaysPage,
} from "#templates/admin/holidays.tsx";
import { holidayFields } from "#templates/fields.ts";

/** Extract holiday input from validated form values */
const extractHolidayInput = (
  values: Record<string, unknown>,
): HolidayInput => ({
  name: values.name as string,
  startDate: values.start_date as string,
  endDate: values.end_date as string,
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
const handleHolidayCreate: RouteHandlerFn = (request) =>
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
  (request: Request, holidayId: number): Promise<Response> =>
    requireOwnerOr(request, (session) =>
      withHoliday(holidayId, (holiday) => htmlResponse(renderPage(holiday, session))));

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
  holidayId: number,
): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const validation = validateForm(form, holidayFields);
    if (!validation.valid) {
      return holidayErrorPage(holidayId, adminHolidayEditPage, session, validation.error);
    }

    const input = extractHolidayInput(validation.values);
    const rangeError = await validateDateRange(input);
    if (rangeError) {
      return holidayErrorPage(holidayId, adminHolidayEditPage, session, rangeError);
    }

    const updated = await holidaysTable.update(holidayId, input);
    if (!updated) return notFoundResponse();

    await logActivity(`Holiday '${String(form.get("name"))}' updated`);
    return redirect("/admin/holidays");
  });

/** Handle GET /admin/holiday/:id/delete */
const handleHolidayDeleteGet = holidayPage(adminHolidayDeletePage);

/** Handle POST /admin/holiday/:id/delete */
const handleHolidayDeletePost = (
  request: Request,
  holidayId: number,
): Promise<Response> =>
  withOwnerAuthForm(request, (session, form) =>
    withHoliday(holidayId, async (holiday) => {
      const confirmIdentifier = String(form.get("confirm_identifier"));
      if (!verifyIdentifier(holiday.name, confirmIdentifier)) {
        return holidayErrorPage(
          holidayId,
          adminHolidayDeletePage,
          session,
          "Holiday name does not match. Please type the exact name to confirm deletion.",
        );
      }

      await holidaysTable.deleteById(holidayId);
      await logActivity(`Holiday '${holiday.name}' deleted`);
      return redirect("/admin/holidays");
    }),
  );

/** Bind :id param to a holiday handler */
type HolidayHandler = (request: Request, holidayId: number) => Response | Promise<Response>;
const holidayRoute = (handler: HolidayHandler): RouteHandlerFn =>
  (request, params) => handler(request, params.id as number);

/** Holiday routes */
export const holidaysRoutes = defineRoutes({
  "GET /admin/holidays": (request) => handleHolidaysGet(request),
  "GET /admin/holiday/new": (request) => handleHolidayNewGet(request),
  "POST /admin/holiday": handleHolidayCreate,
  "GET /admin/holiday/:id/edit": holidayRoute(handleHolidayEditGet),
  "POST /admin/holiday/:id/edit": holidayRoute(handleHolidayEditPost),
  "GET /admin/holiday/:id/delete": holidayRoute(handleHolidayDeleteGet),
  "POST /admin/holiday/:id/delete": holidayRoute(handleHolidayDeletePost),
});
