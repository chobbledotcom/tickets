/**
 * Admin routes - combined from individual route modules
 *
 * GET requests are wrapped to enable SQL query logging for admin users
 * (owners and managers). The debug footer is rendered inline by the
 * Layout template when query logging is active, avoiding response body
 * re-reading which intermittently fails on Bunny Edge.
 */

import { enableQueryLog } from "#lib/db/query-log.ts";
import { settings } from "#lib/db/settings.ts";
import { apiKeysRoutes } from "#routes/admin/api-keys.ts";
import { attendeeRefundRoutes } from "#routes/admin/attendee-refunds.ts";
import { attendeesRoutes } from "#routes/admin/attendees.ts";
import { authRoutes } from "#routes/admin/auth.ts";
import { backupRoutes } from "#routes/admin/backup.ts";
import { builderRoutes } from "#routes/admin/builder.ts";
import { builtSitesRoutes } from "#routes/admin/built-sites.ts";
import { calendarRoutes } from "#routes/admin/calendar.ts";
import { dashboardRoutes } from "#routes/admin/dashboard.ts";
import { debugRoutes } from "#routes/admin/debug.ts";
import { eventsRoutes } from "#routes/admin/events.ts";
import { groupsRoutes } from "#routes/admin/groups.ts";
import { guideRoutes } from "#routes/admin/guide.ts";
import { holidaysRoutes } from "#routes/admin/holidays.ts";
import { questionsRoutes } from "#routes/admin/questions.ts";
import { scannerRoutes } from "#routes/admin/scanner.ts";
import { seedsRoutes } from "#routes/admin/seeds.ts";
import { sessionsRoutes } from "#routes/admin/sessions.ts";
import { settingsRoutes } from "#routes/admin/settings.ts";
import { siteRoutes } from "#routes/admin/site.ts";
import { updateRoutes } from "#routes/admin/update.ts";
import { usersRoutes } from "#routes/admin/users.ts";
import { createRouter } from "#routes/router.ts";
import { getAuthenticatedSession } from "#routes/utils.ts";

/** Combined admin routes */
const adminRoutes = {
  ...dashboardRoutes,
  ...authRoutes,
  ...apiKeysRoutes,
  ...settingsRoutes,
  ...debugRoutes,
  ...siteRoutes,
  ...sessionsRoutes,
  ...calendarRoutes,
  ...eventsRoutes,
  ...attendeesRoutes,
  ...attendeeRefundRoutes,
  ...usersRoutes,
  ...guideRoutes,
  ...groupsRoutes,
  ...holidaysRoutes,
  ...questionsRoutes,
  ...scannerRoutes,
  ...seedsRoutes,
  ...builderRoutes,
  ...builtSitesRoutes,
  ...updateRoutes,
  ...backupRoutes,
};

const innerRouter = createRouter(adminRoutes);

type RouterFn = ReturnType<typeof createRouter>;

/**
 * Route admin requests.
 * For GET requests by authenticated admins, enables query logging so the
 * Layout template renders the debug footer inline.
 */
export const routeAdmin: RouterFn = async (request, path, method, server) => {
  // Check admin status before tracking so the auth queries aren't logged
  const session = await getAuthenticatedSession(request);

  if (method === "GET" && session) {
    enableQueryLog();
    await settings.loadAll();
  }

  return innerRouter(request, path, method, server);
};
