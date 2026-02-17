/**
 * Admin dashboard route
 */

import { getAllowedDomain } from "#lib/config.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { getAllGroups } from "#lib/db/groups.ts";
import { defineRoutes } from "#routes/router.ts";
import { htmlResponse, requireSessionOr, withSession } from "#routes/utils.ts";
import { adminGlobalActivityLogPage } from "#templates/admin/activityLog.tsx";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";

/** Login page response helper */
export const loginResponse = async (error?: string, status = 200): Promise<Response> => {
  const csrfToken = await signCsrfToken();
  return htmlResponse(adminLoginPage(csrfToken, error), status);
};

/**
 * Handle GET /admin/
 */
const handleAdminGet = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) => {
      const imageError = new URL(request.url).searchParams.get("image_error");
      const [events, groups] = await Promise.all([getAllEvents(), getAllGroups()]);
      return htmlResponse(adminDashboardPage(events, groups, session, getAllowedDomain(), imageError));
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
