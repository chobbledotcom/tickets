/**
 * Admin dashboard route
 */

import { getAllEvents } from "#lib/db/events";
import { adminDashboardPage, adminLoginPage } from "#templates/admin.tsx";
import { defineRoutes } from "../router.ts";
import { htmlResponse, withSession } from "../utils.ts";

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
  "GET /admin/": (request) => handleAdminGet(request),
});
