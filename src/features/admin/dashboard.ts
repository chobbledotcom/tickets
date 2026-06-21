/**
 * Admin dashboard route
 */

import { csvResponse, requirePrivateKey } from "#routes/admin/actions.ts";
import { generateListingsCsv } from "#routes/admin/listings-csv.ts";
import { requireSessionOr, sessionPage, withSession } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";
/* jscpd:ignore-start */
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getAllActivityLog, logActivity } from "#shared/db/activityLog.ts";
import {
  decryptAttendees,
  getActiveListingStats,
  getNewestAttendeesRaw,
} from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { getFlash } from "#shared/flash-context.ts";
import {
  filterListingsByType,
  listingTypeFromRequest,
} from "#shared/listing-filter.ts";
import { sortListings } from "#shared/sort-listings.ts";
/* jscpd:ignore-end */
import { adminGlobalActivityLogPage } from "#templates/admin/activityLog.tsx";
import {
  adminDashboardPage,
  adminListingsPage,
} from "#templates/admin/dashboard.tsx";
import { adminLoginPage } from "#templates/admin/login.tsx";

/** Login page response helper */
export const loginResponse = async (
  request: Request,
  status = 200,
): Promise<Response> => {
  const flash = applyFlash(request);
  await signCsrfToken();
  // success (e.g. "Logged out") is rendered by the Layout backstop from context.
  return htmlResponse(adminLoginPage(flash.error), status);
};

/** Maximum number of newest attendees to show on dashboard */
const NEWEST_ATTENDEES_LIMIT = 10;

/** Load every listing, sorted for display (upcoming first). Shared by the
 * listings index page and the listings CSV export. */
const loadSortedListings = async () => {
  const [listings, holidays] = await Promise.all([
    getAllListings(),
    getActiveHolidays(),
  ]);
  return sortListings(listings, holidays);
};

/**
 * Handle GET /admin/
 */
const handleAdminGet = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) => {
      // Delivery agents have no dashboard — send them to their run sheet.
      if (session.adminLevel === "agent") {
        return redirectResponse("/admin/deliveries");
      }
      const { error: imageError, success: successMessage } = getFlash();
      const [listings, holidays, newestRaw, privateKey] = await Promise.all([
        getAllListings(),
        getActiveHolidays(),
        getNewestAttendeesRaw(NEWEST_ATTENDEES_LIMIT),
        requirePrivateKey(session),
      ]);
      const newestAttendees = await decryptAttendees(newestRaw, privateKey);
      const sortedListings = sortListings(listings, holidays);
      const stats = await getActiveListingStats(sortedListings);
      const activeType = listingTypeFromRequest(request);
      return htmlResponse(
        adminDashboardPage(
          sortedListings,
          session,
          imageError,
          newestAttendees,
          successMessage,
          stats,
          settings.listingColumnOrder,
          activeType,
          holidays,
        ),
      );
    },
    () => loginResponse(request),
  );

/** Handle GET /admin/listings */
const handleAdminListingsGet: TypedRouteHandler<"GET /admin/listings"> =
  sessionPage(async (session) =>
    adminListingsPage(
      await loadSortedListings(),
      session,
      settings.listingColumnOrder,
    ),
  );

/** Handle GET /admin/listings/csv — export every listing (filtered by the same
 * ?type= category filter the listings views use) as a CSV download. */
const handleListingsCsvExport: TypedRouteHandler<"GET /admin/listings/csv"> = (
  request,
) =>
  requireSessionOr(request, async () => {
    const type = listingTypeFromRequest(request);
    const listings = filterListingsByType(type)(await loadSortedListings());
    const csv = generateListingsCsv(listings, settings.timezone);
    const suffix = type === "all" ? "" : `_${type}`;
    await logActivity(
      `Listings CSV exported${type === "all" ? "" : ` (type: ${type})`}`,
    );
    return csvResponse(csv, `listings${suffix}.csv`);
  });

/** Maximum number of log entries to display */
const LOG_DISPLAY_LIMIT = 200;

/**
 * Handle GET /admin/log
 */
const handleAdminLog: TypedRouteHandler<"GET /admin/log"> = sessionPage(
  async (session) => {
    const entries = await getAllActivityLog(LOG_DISPLAY_LIMIT + 1);
    const truncated = entries.length > LOG_DISPLAY_LIMIT;
    const displayEntries = truncated
      ? entries.slice(0, LOG_DISPLAY_LIMIT)
      : entries;
    return adminGlobalActivityLogPage(displayEntries, truncated, session);
  },
);

/** Dashboard routes */
export const dashboardRoutes = defineRoutes({
  "GET /admin": handleAdminGet,
  "GET /admin/listings": handleAdminListingsGet,
  "GET /admin/listings/csv": handleListingsCsvExport,
  "GET /admin/log": handleAdminLog,
});
