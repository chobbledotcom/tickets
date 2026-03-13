/**
 * Admin routes - combined from individual route modules
 *
 * GET requests are wrapped to enable SQL query logging for admin users
 * (owners and managers). The debug footer is rendered inline by the
 * Layout template when query logging is active, avoiding response body
 * re-reading which intermittently fails on Bunny Edge.
 */

import { enableQueryLog } from "#lib/db/query-log.ts";
import { loadAllSettings } from "#lib/db/settings.ts";
import { attendeesRoutes } from "#routes/admin/attendees.ts";
import { authRoutes } from "#routes/admin/auth.ts";
import { calendarRoutes } from "#routes/admin/calendar.ts";
import { dashboardRoutes } from "#routes/admin/dashboard.ts";
import { eventsRoutes } from "#routes/admin/events.ts";
import { groupsRoutes } from "#routes/admin/groups.ts";
import { guideRoutes } from "#routes/admin/guide.ts";
import { holidaysRoutes } from "#routes/admin/holidays.ts";
import { scannerRoutes } from "#routes/admin/scanner.ts";
import { seedsRoutes } from "#routes/admin/seeds.ts";
import { sessionsRoutes } from "#routes/admin/sessions.ts";
import { settingsRoutes } from "#routes/admin/settings.ts";
import { siteRoutes } from "#routes/admin/site.ts";
import { usersRoutes } from "#routes/admin/users.ts";
import { createRouter } from "#routes/router.ts";
import { getAuthenticatedSession } from "#routes/utils.ts";

/** Combined admin routes */
const adminRoutes = {
  ...dashboardRoutes,
  ...authRoutes,
  ...settingsRoutes,
  ...siteRoutes,
  ...sessionsRoutes,
  ...calendarRoutes,
  ...eventsRoutes,
  ...attendeesRoutes,
  ...usersRoutes,
  ...guideRoutes,
  ...groupsRoutes,
  ...holidaysRoutes,
  ...scannerRoutes,
  ...seedsRoutes,
};

const innerRouter = createRouter(adminRoutes);

type RouterFn = ReturnType<typeof createRouter>;

/**
 * Route admin requests.
 * For GET requests by authenticated admins (owner or manager), enables
 * query logging so the Layout template renders the debug footer inline.
 */
export const routeAdmin: RouterFn = async (request, path, method, server) => {
  if (method !== "GET") {
    return innerRouter(request, path, method, server);
  }

  // Check admin status before tracking so the auth queries aren't logged
  const session = await getAuthenticatedSession(request);
  if (session) {
    enableQueryLog();
    await loadAllSettings();
  }

  return innerRouter(request, path, method, server);
};
