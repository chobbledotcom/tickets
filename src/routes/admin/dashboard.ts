/**
 * Admin dashboard route
 */

import { getAllEvents } from "#lib/db/events.ts";
import { defineRoutes } from "#routes/router.ts";
import { htmlResponse, withSession } from "#routes/utils.ts";
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

/** Dashboard routes */
export const dashboardRoutes = defineRoutes({
  "GET /admin": (request) => handleAdminGet(request),
});
