/**
 * Admin dashboard route
 */

import { getAllowedDomain } from "#lib/config.ts";
import { buildCsrfCookie } from "#lib/cookies.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { defineRoutes } from "#routes/router.ts";
import { generateSecureToken, htmlResponse, htmlResponseWithCookie, requireSessionOr, withSession } from "#routes/utils.ts";
import { adminGlobalActivityLogPage } from "#templates/admin/activityLog.tsx";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";

/** Generate login CSRF cookie string */
const loginCsrfCookie = (token: string): string =>
  buildCsrfCookie("admin_login_csrf", token, { path: "/admin" });

/** Login page response helper */
export const loginResponse = (error?: string, status = 200) => {
  const csrfToken = generateSecureToken();
  return htmlResponseWithCookie(loginCsrfCookie(csrfToken))(
    adminLoginPage(csrfToken, error),
    status,
  );
};

/**
 * Handle GET /admin/
 */
const handleAdminGet = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) => {
      const imageError = new URL(request.url).searchParams.get("image_error");
      return htmlResponse(adminDashboardPage(await getAllEvents(), session, getAllowedDomain(), imageError));
    },
    () => loginResponse(),
  );

/** Maximum number of log entries to display */
const LOG_DISPLAY_LIMIT = 200;

/**
 * Handle GET /admin/log
 */
const handleAdminLog = (request: Request): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const entries = await getAllActivityLog(LOG_DISPLAY_LIMIT + 1);
    const truncated = entries.length > LOG_DISPLAY_LIMIT;
    const displayEntries = truncated ? entries.slice(0, LOG_DISPLAY_LIMIT) : entries;
    return htmlResponse(adminGlobalActivityLogPage(displayEntries, truncated, session));
  });

/** Dashboard routes */
export const dashboardRoutes = defineRoutes({
  "GET /admin": (request) => handleAdminGet(request),
  "GET /admin/log": (request) => handleAdminLog(request),
});
