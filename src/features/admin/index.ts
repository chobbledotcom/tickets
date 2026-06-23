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
import { contactHistoryRoutes } from "#routes/admin/contact-history.ts";
import { dashboardRoutes } from "#routes/admin/dashboard.ts";
import { debugRoutes } from "#routes/admin/debug.ts";
import { deliveriesRoutes } from "#routes/admin/deliveries.ts";
import { groupsRoutes } from "#routes/admin/groups.ts";
import { guideRoutes } from "#routes/admin/guide.ts";
import { holidaysRoutes } from "#routes/admin/holidays.ts";
import { ledgerRoutes } from "#routes/admin/ledger.ts";
import { listingQrRoutes } from "#routes/admin/listing-qr.ts";
import { listingsRoutes } from "#routes/admin/listings.ts";
import { markdownPreviewRoutes } from "#routes/admin/markdown-preview.ts";
import { modifiersRoutes } from "#routes/admin/modifiers.ts";
import { privacyRoutes } from "#routes/admin/privacy.ts";
import { questionsRoutes } from "#routes/admin/questions.ts";
import { scannerRoutes } from "#routes/admin/scanner.ts";
import { seedsRoutes } from "#routes/admin/seeds.ts";
import { sessionsRoutes } from "#routes/admin/sessions.ts";
import { settingsRoutes } from "#routes/admin/settings.ts";
import { logisticsRoutes } from "#routes/admin/settings-logistics.ts";
import { attendeeStatusesRoutes } from "#routes/admin/settings-statuses.ts";
import { siteRoutes } from "#routes/admin/site.ts";
import { smsRoutes } from "#routes/admin/sms.ts";
import { supportRoutes } from "#routes/admin/support.ts";
import { updateRoutes } from "#routes/admin/update.ts";
import { usersRoutes } from "#routes/admin/users.ts";
import { getAuthenticatedSession } from "#routes/auth.ts";
import { createRouter, type RouteHandlerFn } from "#routes/router.ts";
import { enableFooterDebug } from "#shared/db/query-log.ts";

/** Route maps merged in order (later keys override earlier on conflict) */
const adminRouteModules: Record<string, RouteHandlerFn>[] = [
  dashboardRoutes,
  authRoutes,
  deliveriesRoutes,
  apiKeysRoutes,
  settingsRoutes,
  logisticsRoutes,
  attendeeStatusesRoutes,
  privacyRoutes,
  debugRoutes,
  siteRoutes,
  sessionsRoutes,
  calendarRoutes,
  listingsRoutes,
  listingQrRoutes,
  markdownPreviewRoutes,
  attendeesRoutes,
  contactHistoryRoutes,
  smsRoutes,
  attendeeRefundRoutes,
  usersRoutes,
  guideRoutes,
  ledgerRoutes,
  groupsRoutes,
  modifiersRoutes,
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
  // Query recording is turned on earlier (prepareRequestEnvironment) for admin
  // GETs, so the route's settings load is captured. Here we only unlock the
  // footer for staff — delivery agents never see the debug footer.
  const session = await getAuthenticatedSession(request);

  if (method === "GET" && session && session.adminLevel !== "agent") {
    enableFooterDebug();
  }

  return innerRouter(request, path, method, server);
};
