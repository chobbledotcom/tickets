/**
 * Admin dashboard route
 */

import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { defineRoutes } from "#routes/router.ts";
import { htmlResponse, requireSessionOr, withSession } from "#routes/utils.ts";
import { adminGlobalActivityLogPage } from "#templates/admin/activityLog.tsx";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";

/** Login page response helper */
export const loginResponse = (error?: string, status = 200) =>
  htmlResponse(adminLoginPage(error), status);

/**
 * Handle GET /admin/
 */
const handleAdminGet = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) =>
      htmlResponse(adminDashboardPage(await getAllEvents(), session.csrfToken)),
    () => loginResponse(),
  );

/**
 * Handle GET /admin/activity-log
 */
const handleAdminActivityLog = (request: Request): Promise<Response> =>
  requireSessionOr(request, async () =>
    htmlResponse(adminGlobalActivityLogPage(await getAllActivityLog())),
  );

/** Dashboard routes */
export const dashboardRoutes = defineRoutes({
  "GET /admin": (request) => handleAdminGet(request),
  "GET /admin/activity-log": (request) => handleAdminActivityLog(request),
});
