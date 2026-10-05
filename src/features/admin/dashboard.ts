import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";

/**
 * Admin dashboard route
 */

/* jscpd:ignore-start -- imports */
import {
  type ActivityLogEntry,
  getAllActivityLog,
  logActivity,
} from "#db/activity-log.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getNewestAttendeesRaw } from "#db/attendees/queries.ts";
import { getUpcomingServicingEvents } from "#db/attendees/servicing.ts";
import { getActiveListingStats } from "#db/attendees/stats.ts";
import { getSelectedAttributesForListings } from "#db/attributes.ts";
import { getAllGroupNames, getListingsByGroupId } from "#db/groups.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import { getNonStandaloneChildIds } from "#db/listing-parents.ts";
import { getAllListings, listingNames } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
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
import { getFlash } from "#shared/flash-context.ts";
import { groupScopeOptions } from "#shared/ledger-scope.ts";
import {
  attributeFilterGroupsForListings,
  filterListingsByAttributes,
  selectedAttributeFiltersFromRequest,
} from "#shared/listing-attribute-filter.ts";
import {
  filterListingsByType,
  groupIdFromRequest,
  listingTypeFromRequest,
} from "#shared/listing-filter.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { loadSortedListings, sortListings } from "#shared/sort-listings.ts";
import { todayInTz } from "#shared/timezone.ts";
/* jscpd:ignore-end */
import {
  type ActivityLogRefs,
  adminGlobalActivityLogPage,
} from "#templates/admin/activity-log.tsx";
import {
  adminDashboardPage,
  adminListingsPage,
} from "#templates/admin/dashboard.tsx";
import type { ListingAttributeFilterView } from "#templates/admin/listing-attribute-filters.ts";
import { adminLoginPage } from "#templates/admin/login.tsx";
import type { ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** Login page response helper */
export const loginResponse = async (
  request: Request,
  status = 200,
): Promise<Response> => {
  // success (for example, "Logged out") is rendered by the Layout backstop
  // from context.
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
      // Restricted roles have no dashboard. Their landing path is their only
      // page (agents), a page without the dashboard's financials (editors),
      // or the doors list (scanner users). The landing map decides who
      // redirects.
      if (adminLandingPath(session.adminLevel) !== "/admin") {
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
      const activeListings = filter(
        (listing: ListingWithCount) => listing.active,
      )(sortedListings);
      const [upcomingServicingEvents, attributeContext] = await Promise.all([
        getUpcomingServicingEvents(privateKey, todayInTz(settings.timezone)),
        loadListingAttributeFilterContext(request, activeListings),
      ]);
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
          upcomingServicingEvents,
          attributeContext,
        ),
      );
    },
    () => loginResponse(request),
  );

/** Editors land on this page, so it is gated to content roles (staff +
 * editor). The template renders role-aware columns and links, so editors see
 * no financials or forbidden detail links. */
/** The loaded listings that belong to the chosen group, in the loaded order. */
const keepListingsInGroup = (
  listings: ListingWithCount[],
  members: ListingWithCount[],
): ListingWithCount[] => {
  const memberIds = new Set(members.map((listing) => listing.id));
  return listings.filter((listing) => memberIds.has(listing.id));
};

const handleAdminListingsGet: TypedRouteHandler<"GET /admin/listings"> =
  contentPage(async (session, request) => {
    const groups = groupScopeOptions(await getAllGroupNames());
    const groupId = groupIdFromRequest(request, groups);
    const [memberListings, { listings }] = await Promise.all([
      groupId === null ? null : getListingsByGroupId(groupId),
      loadSortedListings(),
    ]);
    // One membership read narrows the whole page: the tables, the deactivated
    // section, and the multi-booking builder all start from this list.
    const shownListings =
      memberListings === null
        ? listings
        : keepListingsInGroup(listings, memberListings);
    // The attribute filter context stays on the full set, so a bar recognises
    // an attribute that only exists outside the chosen group. The type filter
    // makes the same choice today.
    const [attributeContext, unbookableIds] = await Promise.all([
      loadListingAttributeFilterContext(request, listings),
      getNonStandaloneChildIds(listings.map((listing) => listing.id)),
    ]);
    return adminListingsPage(
      shownListings,
      session,
      session.adminLevel === "editor"
        ? undefined
        : settings.listingColumnLayout,
      attributeContext,
      unbookableIds,
      { activeGroupId: groupId, groups },
    );
  });

/** Exports every listing, filtered by the same ?type= category and attribute
 * filters the listings views use. The attribute filter context loads from the
 * full listing set, before the type filter narrows it. An attribute that only
 * exists on a different listing type is then still recognised by
 * selectedAttributeFiltersFromRequest rather than silently dropped. */
const handleListingsCsvExport: TypedRouteHandler<"GET /admin/listings/csv"> = (
  request,
) =>
  requireSessionOr(request, async () => {
    const groupNames = await getAllGroupNames();
    const groups = groupScopeOptions(groupNames);
    const groupId = groupIdFromRequest(request, groups);
    const memberListings =
      groupId === null ? null : await getListingsByGroupId(groupId);
    const { listings: allListings } = await loadSortedListings();
    const inGroupListings =
      memberListings === null
        ? allListings
        : keepListingsInGroup(allListings, memberListings);
    const type = listingTypeFromRequest(request);
    const { activeAttributeFilters, attributesByListing } =
      await loadListingAttributeFilterContext(request, allListings);
    const filteredListings = filterListingsByAttributes(
      activeAttributeFilters,
      attributesByListing,
    )(filterListingsByType(type)(inGroupListings));
    const csv = generateListingsCsv(filteredListings, settings.timezone);
    const suffix = type === "all" ? "" : `_${type}`;
    await logActivity(
      `Listings CSV exported${type === "all" ? "" : ` (type: ${type})`}${
        groupId === null ? "" : ` (group: ${groupNames.get(groupId)})`
      }`,
    );
    return csvResponse(csv, `listings${suffix}.csv`);
  });

/** Maximum number of log entries to display */
const LOG_DISPLAY_LIMIT = 200;

/**
 * Resolve the attendee and listing display names referenced by a batch of log
 * entries. The global log then shows each entry's attendee and listing as a
 * link. Both are bounded id → name lookups over only the ids the entries
 * reference. Attendee names are decrypted with the current request's private
 * key. Listing names come from the listings table. The page never scans whole
 * tables to label a few rows. An attendee deleted since then has no entry
 * here. Its log rows keep the id but render without a link.
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
