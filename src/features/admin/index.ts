/**
 * Admin routes - combined from individual route modules
 *
 * GET requests are wrapped to enable SQL query logging for admin users
 * (owners and managers). The debug footer is rendered inline by the
 * Layout template when query logging is active, avoiding response body
 * re-reading which intermittently fails on Bunny Edge.
 */

import { reduce } from "#fp";
import { apiKeysRoutes } from "#routes/admin/api-keys.ts";
import { attendeeRefundRoutes } from "#routes/admin/attendee-refunds.ts";
import { attendeesRoutes } from "#routes/admin/attendees.ts";
import { authRoutes } from "#routes/admin/auth.ts";
import { backupRoutes } from "#routes/admin/backup.ts";
import { builderRoutes } from "#routes/admin/builder.ts";
import { builtSitesRoutes } from "#routes/admin/built-sites.ts";
import { bulkActionsRoutes } from "#routes/admin/bulk-actions.ts";
import { bulkEmailRoutes } from "#routes/admin/bulk-email.ts";
import { calendarRoutes } from "#routes/admin/calendar.ts";
import { dashboardRoutes } from "#routes/admin/dashboard.ts";
import { debugRoutes } from "#routes/admin/debug.ts";
import { groupsRoutes } from "#routes/admin/groups.ts";
import { guideRoutes } from "#routes/admin/guide.ts";
import { holidaysRoutes } from "#routes/admin/holidays.ts";
import { listingQrRoutes } from "#routes/admin/listing-qr.ts";
import { listingsRoutes } from "#routes/admin/listings.ts";
import { markdownPreviewRoutes } from "#routes/admin/markdown-preview.ts";
import { questionsRoutes } from "#routes/admin/questions.ts";
import { scannerRoutes } from "#routes/admin/scanner.ts";
import { seedsRoutes } from "#routes/admin/seeds.ts";
import { sessionsRoutes } from "#routes/admin/sessions.ts";
import { settingsRoutes } from "#routes/admin/settings.ts";
import { deliveryRoutes } from "#routes/admin/settings-delivery.ts";
import { attendeeStatusesRoutes } from "#routes/admin/settings-statuses.ts";
import { siteRoutes } from "#routes/admin/site.ts";
import { supportRoutes } from "#routes/admin/support.ts";
import { updateRoutes } from "#routes/admin/update.ts";
import { usersRoutes } from "#routes/admin/users.ts";
import { getAuthenticatedSession } from "#routes/auth.ts";
import { createRouter, type RouteHandlerFn } from "#routes/router.ts";
import { enableQueryLog } from "#shared/db/query-log.ts";
import { settings } from "#shared/db/settings.ts";

/** Route maps merged in order (later keys override earlier on conflict) */
const adminRouteModules: Record<string, RouteHandlerFn>[] = [
  dashboardRoutes,
  authRoutes,
  apiKeysRoutes,
  settingsRoutes,
  deliveryRoutes,
  attendeeStatusesRoutes,
  debugRoutes,
  siteRoutes,
  sessionsRoutes,
  calendarRoutes,
  listingsRoutes,
  listingQrRoutes,
  markdownPreviewRoutes,
  attendeesRoutes,
  attendeeRefundRoutes,
  usersRoutes,
  guideRoutes,
  groupsRoutes,
  bulkActionsRoutes,
  bulkEmailRoutes,
  holidaysRoutes,
  questionsRoutes,
  scannerRoutes,
  seedsRoutes,
  builderRoutes,
  builtSitesRoutes,
  updateRoutes,
  backupRoutes,
  supportRoutes,
];

const adminRoutes = reduce(
  (acc, mod) => Object.assign(acc, mod),
  {} as Record<string, RouteHandlerFn>,
)(adminRouteModules);

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
