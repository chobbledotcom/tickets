import { defineRoutes } from "#routes/router.ts";
/**
 * Admin dashboard route
 */

import { compact, filter, unique } from "#fp";
import { csvResponse, loadAttendeeLinkRefs } from "#routes/admin/actions.ts";
import { generateListingsCsv } from "#routes/admin/listings-csv.ts";
import {
  adminLandingPath,
  contentPage,
  requireSessionOr,
  sessionPage,
  withSession,
} from "#routes/auth.ts";
import { flashForPage } from "#routes/flash-for-page.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";
/* jscpd:ignore-start */
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  type ActivityLogEntry,
  getAllActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getNewestAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getUpcomingServicingEvents } from "#shared/db/attendees/servicing.ts";
import { getActiveListingStats } from "#shared/db/attendees/stats.ts";
import { getSelectedAttributesForListings } from "#shared/db/attributes.ts";
import { getHiddenPackageMemberIds } from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getNonStandaloneChildIds } from "#shared/db/listing-parents.ts";
import { getAllListings, listingNames } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { getFlash } from "#shared/flash-context.ts";
import {
  attributeFilterGroupsForListings,
  filterListingsByAttributes,
  selectedAttributeFiltersFromRequest,
} from "#shared/listing-attribute-filter.ts";
import {
  filterListingsByType,
  listingTypeFromRequest,
} from "#shared/listing-filter.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { loadSortedListings, sortListings } from "#shared/sort-listings.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
/* jscpd:ignore-end */
import {
  type ActivityLogRefs,
  adminGlobalActivityLogPage,
} from "#templates/admin/activityLog.tsx";
import {
  adminDashboardPage,
  adminListingsPage,
} from "#templates/admin/dashboard.tsx";
import type { ListingAttributeFilterView } from "#templates/admin/listing-attribute-filters.ts";
import { adminLoginPage } from "#templates/admin/login.tsx";

/** Login page response helper */
export const loginResponse = async (
  request: Request,
  status = 200,
): Promise<Response> => {
  // success (e.g. "Logged out") is rendered by the Layout backstop from context.
  const flash = await flashForPage(request);
  return htmlResponse(adminLoginPage(flash.error), status);
};

/** Maximum number of newest attendees to show on dashboard */
const NEWEST_ATTENDEES_LIMIT = 10;

const loadListingAttributeFilterContext = async (
  request: Request,
  filterSource: ListingWithCount[],
): Promise<ListingAttributeFilterView> => {
  const attributesByListing = await getSelectedAttributesForListings(
    filterSource.map((listing) => listing.id),
  );
  const attributeFilters = attributeFilterGroupsForListings(
    filterSource.map((listing) => listing.id),
    attributesByListing,
  );
  return {
    activeAttributeFilters: selectedAttributeFiltersFromRequest(
      request,
      attributeFilters,
    ),
    attributeFilters,
    attributesByListing,
  };
};

/**
 * Handle GET /admin/
 */
const handleAdminGet = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) => {
      // Delivery agents and editors have no dashboard — agents go to their run
      // sheet; editors go to listings (the dashboard shows ledger/income figures
      // they may not see, and would require a private key they don't hold).
      if (session.adminLevel === "agent" || session.adminLevel === "editor") {
        return redirectResponse(adminLandingPath(session.adminLevel));
      }
      const { error: imageError, success: successMessage } = getFlash();
      const [listings, holidays, newestRaw, privateKey] = await Promise.all([
        getAllListings(),
        getActiveHolidays(),
        getNewestAttendeesRaw(NEWEST_ATTENDEES_LIMIT),
        requireRequestPrivateKey(),
      ]);
      const newestAttendees = await decryptAttendees(newestRaw, privateKey);
      const sortedListings = sortListings(listings, holidays);
      const stats = await getActiveListingStats(sortedListings);
      const activeType = listingTypeFromRequest(request);
      // Listings with no standalone public page are excluded from the
      // multi-booking link builder: a booking can never start from a
      // non-standalone child, and a hidden package's member 404s
      // on its own `/ticket/<slug>` — so a `/ticket/<member+other>` URL the
      // builder emits would be rejected by the server. A `bookable_alone` child
      // has its own page, so it stays bookable here.
      const listingIds = sortedListings.map((l) => l.id);
      const activeListings = filter(
        (listing: ListingWithCount) => listing.active,
      )(sortedListings);
      const [
        childIds,
        hiddenMemberIds,
        upcomingServicingEvents,
        attributeContext,
      ] = await Promise.all([
        getNonStandaloneChildIds(listingIds),
        getHiddenPackageMemberIds(listingIds),
        getUpcomingServicingEvents(privateKey, todayInTz(settings.timezone)),
        loadListingAttributeFilterContext(request, activeListings),
      ]);
      const unbookableIds = new Set([...childIds, ...hiddenMemberIds]);
      return htmlResponse(
        adminDashboardPage(
          sortedListings,
          session,
          imageError,
          newestAttendees,
          successMessage,
          stats,
          settings.listingColumnLayout,
          activeType,
          holidays,
          unbookableIds,
          upcomingServicingEvents,
          attributeContext,
        ),
      );
    },
    () => loginResponse(request),
  );

/** Handle GET /admin/listings — the listings index. Editors land here, so it is
 * gated to content roles (staff + editor); the template renders role-aware
 * columns/links so editors see no financials or forbidden detail links. */
const handleAdminListingsGet: TypedRouteHandler<"GET /admin/listings"> =
  contentPage(async (session, request) => {
    const { listings } = await loadSortedListings();
    return adminListingsPage(
      listings,
      session,
      session.adminLevel === "editor"
        ? undefined
        : settings.listingColumnLayout,
      await loadListingAttributeFilterContext(request, listings),
    );
  });

/** Handle GET /admin/listings/csv — export every listing (filtered by the same
 * ?type= category and attribute filters the listings views use) as a CSV
 * download. The attribute filter context is loaded from the full listing set
 * (before the type filter narrows it) so an attribute that only exists on a
 * different listing type is still recognised by selectedAttributeFiltersFromRequest
 * rather than silently dropped. */
const handleListingsCsvExport: TypedRouteHandler<"GET /admin/listings/csv"> = (
  request,
) =>
  requireSessionOr(request, async () => {
    const { listings: allListings } = await loadSortedListings();
    const type = listingTypeFromRequest(request);
    const { activeAttributeFilters, attributesByListing } =
      await loadListingAttributeFilterContext(request, allListings);
    const filteredListings = filterListingsByAttributes(
      activeAttributeFilters,
      attributesByListing,
    )(filterListingsByType(type)(allListings));
    const csv = generateListingsCsv(filteredListings, settings.timezone);
    const suffix = type === "all" ? "" : `_${type}`;
    await logActivity(
      `Listings CSV exported${type === "all" ? "" : ` (type: ${type})`}`,
    );
    return csvResponse(csv, `listings${suffix}.csv`);
  });

/** Maximum number of log entries to display */
const LOG_DISPLAY_LIMIT = 200;

/**
 * Resolve the attendee and listing display names referenced by a batch of log
 * entries, so the global log can show each entry's attendee/listing as a link.
 * Both are bounded id → name lookups over only the ids the entries reference —
 * attendee names decrypted with the current request's private key, listing names
 * from the listings table — so the page never scans whole tables to label a few
 * rows. An attendee that has since been deleted simply has no entry here; its
 * log rows keep the id but render without a link.
 */
const loadActivityLogRefs = async (
  entries: ActivityLogEntry[],
): Promise<ActivityLogRefs> => {
  const attendeeIds = unique(compact(entries.map((e) => e.attendee_id)));
  const listingIds = unique(compact(entries.map((e) => e.listing_id)));
  const [attendees, listings] = await Promise.all([
    loadAttendeeLinkRefs(attendeeIds),
    listingNames.byIds(listingIds),
  ]);
  return { attendees, listings };
};

/**
 * Handle GET /admin/log
 */
const handleAdminLog: TypedRouteHandler<"GET /admin/log"> = sessionPage(
  async (session) => {
    const entries = await getAllActivityLog(LOG_DISPLAY_LIMIT + 1);
    const truncated = entries.length > LOG_DISPLAY_LIMIT;
    const displayEntries = entries.slice(0, LOG_DISPLAY_LIMIT);
    const refs = await loadActivityLogRefs(displayEntries);
    return adminGlobalActivityLogPage(displayEntries, truncated, session, refs);
  },
);

/** Dashboard routes */
export const adminHandlers = defineRoutes({
  "GET /admin": handleAdminGet,
  "GET /admin/listings": handleAdminListingsGet,
  "GET /admin/listings/csv": handleListingsCsvExport,
  "GET /admin/log": handleAdminLog,
});
