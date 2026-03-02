/**
 * Admin dashboard route
 */

import { signCsrfToken } from "#lib/csrf.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { decryptAttendees, getNewestAttendeesRaw } from "#lib/db/attendees.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import { sortEvents } from "#lib/sort-events.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { requirePrivateKey } from "#routes/admin/utils.ts";
import { htmlResponse, requireSessionOr, withSession } from "#routes/utils.ts";
import { adminGlobalActivityLogPage } from "#templates/admin/activityLog.tsx";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";

/** Login page response helper */
export const loginResponse = async (error?: string, status = 200): Promise<Response> => {
  await signCsrfToken();
  return htmlResponse(adminLoginPage(error), status);
};

/** Maximum number of newest attendees to show on dashboard */
const NEWEST_ATTENDEES_LIMIT = 10;

/**
 * Handle GET /admin/
 */
const handleAdminGet = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) => {
      const url = new URL(request.url);
      const imageError = url.searchParams.get("image_error");
      const successMessage = url.searchParams.get("success");
      const [events, holidays, newestRaw, privateKey] = await Promise.all([
        getAllEvents(),
        getActiveHolidays(),
        getNewestAttendeesRaw(NEWEST_ATTENDEES_LIMIT),
        requirePrivateKey(session),
      ]);
      const newestAttendees = await decryptAttendees(newestRaw, privateKey);
      const sortedEvents = sortEvents(events, holidays);
      return htmlResponse(adminDashboardPage(sortedEvents, session, imageError, newestAttendees, successMessage));
    },
    () => loginResponse(),
  );

/** Maximum number of log entries to display */
const LOG_DISPLAY_LIMIT = 200;

/**
 * Handle GET /admin/log
 */
const handleAdminLog: TypedRouteHandler<"GET /admin/log"> = (request) =>
  requireSessionOr(request, async (session) => {
    const entries = await getAllActivityLog(LOG_DISPLAY_LIMIT + 1);
    const truncated = entries.length > LOG_DISPLAY_LIMIT;
    const displayEntries = truncated ? entries.slice(0, LOG_DISPLAY_LIMIT) : entries;
    return htmlResponse(adminGlobalActivityLogPage(displayEntries, truncated, session));
  });

/** Dashboard routes */
export const dashboardRoutes = defineRoutes({
  "GET /admin": handleAdminGet,
  "GET /admin/log": handleAdminLog,
});
