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
import { attendeesRoutes } from "#routes/admin/attendees.ts";
import { authRoutes } from "#routes/admin/auth.ts";
import { calendarRoutes } from "#routes/admin/calendar.ts";
import { dashboardRoutes } from "#routes/admin/dashboard.ts";
import { debugRoutes } from "#routes/admin/debug.ts";
import { eventsRoutes } from "#routes/admin/events.ts";
import { groupsRoutes } from "#routes/admin/groups.ts";
import { guideRoutes } from "#routes/admin/guide.ts";
import { holidaysRoutes } from "#routes/admin/holidays.ts";
import { migrateRoutes } from "#routes/admin/migrate.ts";
import { questionsRoutes } from "#routes/admin/questions.ts";
import { scannerRoutes } from "#routes/admin/scanner.ts";
import { seedsRoutes } from "#routes/admin/seeds.ts";
import { sessionsRoutes } from "#routes/admin/sessions.ts";
import { settingsRoutes } from "#routes/admin/settings.ts";
import { siteRoutes } from "#routes/admin/site.ts";
import { usersRoutes } from "#routes/admin/users.ts";
import { createRouter } from "#routes/router.ts";
import { getAuthenticatedSession, redirectResponse } from "#routes/utils.ts";

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
  ...usersRoutes,
  ...guideRoutes,
  ...groupsRoutes,
  ...holidaysRoutes,
  ...questionsRoutes,
  ...scannerRoutes,
  ...seedsRoutes,
  ...migrateRoutes,
};

const innerRouter = createRouter(adminRoutes);

type RouterFn = ReturnType<typeof createRouter>;

/** Routes that are always accessible (auth + migration itself) */
const UNGATED_PREFIXES = [
  "/admin/migrate",
  "/admin/login",
  "/admin/logout",
] as const;

const isUngatedRoute = (path: string): boolean =>
  UNGATED_PREFIXES.some((p) => path.startsWith(p));

/**
 * Route admin requests.
 * Gates all admin routes (except auth and migrate) behind migration completion.
 * For GET requests by authenticated admins, enables query logging so the
 * Layout template renders the debug footer inline.
 */
export const routeAdmin: RouterFn = async (request, path, method, server) => {
  // Check admin status before tracking so the auth queries aren't logged
  const session = await getAuthenticatedSession(request);

  // Load settings before migration check so isAttendeeBlobMigrated() uses
  // a fresh DB read instead of a potentially stale cache entry.
  if (method === "GET" && session) {
    enableQueryLog();
    await settings.loadAll();
  }

  // Gate non-auth routes behind migration completion
  if (session && !isUngatedRoute(path)) {
    const migrated = await settings.attendeeBlobMigrated.is();
    if (!migrated) return redirectResponse("/admin/migrate");
  }

  return innerRouter(request, path, method, server);
};
