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
import { getAllGroupNames } from "#db/groups.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import { getNonStandaloneChildIds } from "#db/listing-parents.ts";
import { getAllListings, listingNames } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { compact, filter, unique } from "#fp";
import { t } from "#i18n";
import { csvResponse, loadAttendeeLinkRefs } from "#routes/admin/actions.ts";
import { generateListingsCsv } from "#routes/admin/listings-csv.ts";
import { returnPathFromQuery } from "#routes/admin/login-return.ts";
import {
  contentPage,
  formPost,
  OWNER_FORM,
  requireSessionOr,
  sessionPage,
  withSession,
} from "#routes/auth.ts";
import { flashForPage } from "#routes/flash-for-page.ts";
import { htmlResponse, redirect, redirectResponse } from "#routes/response.ts";
import { adminLandingPath } from "#shared/admin-pages.ts";
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
import {
  groupMemberIds,
  loadSortedListings,
  sortListings,
} from "#shared/sort-listings.ts";
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

export const loginResponse = async (
  request: Request,
  status = 200,
): Promise<Response> => {
  // success (for example, "Logged out") is rendered by the Layout backstop
  // from context.
  const flash = await flashForPage(request);
  return htmlResponse(
    adminLoginPage(flash.error, returnPathFromQuery(request)),
    status,
  );
};

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
          // The welcome steps are the owner's alone. Managers share the page
          // without them.
          session.adminLevel === "owner" && !settings.welcomeDismissed,
        ),
      );
    },
    () => loginResponse(request),
  );

/** The loaded listings that belong to the chosen group, in the loaded order. */
const keepListingsInGroup = (
  listings: ListingWithCount[],
  memberIds: ReadonlySet<number>,
): ListingWithCount[] =>
  listings.filter((listing) => memberIds.has(listing.id));

/** Editors land on this page, so it is gated to content roles (staff +
 * editor). The template renders role-aware columns and links, so editors see
 * no financials or forbidden detail links. */
const handleAdminListingsGet: TypedRouteHandler<"GET /admin/listings"> =
  contentPage(async (session, request) => {
    const groups = groupScopeOptions(await getAllGroupNames());
    const groupId = groupIdFromRequest(request, groups);
    const [memberIds, { listings }] = await Promise.all([
      groupId === null ? null : groupMemberIds(groupId),
      loadSortedListings(),
    ]);
    // One membership read narrows the whole page: the tables, the deactivated
    // section, and the multi-booking builder all start from this list.
    const shownListings =
      memberIds === null ? listings : keepListingsInGroup(listings, memberIds);
    // The attribute filter context stays on the full set, so a bar recognises
    // an attribute that only exists outside the chosen group. The type filter
    // makes the same choice today.
    // The multi-booking builder offers only listings with a standalone
    // booking page. A `bookable_alone` child keeps its own page, so it stays.
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
    const memberIds = groupId === null ? null : await groupMemberIds(groupId);
    const { listings: allListings } = await loadSortedListings();
    const inGroupListings =
      memberIds === null
        ? allListings
        : keepListingsInGroup(allListings, memberIds);
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

const handleAdminLog: TypedRouteHandler<"GET /admin/log"> = sessionPage(
  async (session) => {
    const entries = await getAllActivityLog(LOG_DISPLAY_LIMIT + 1);
    const truncated = entries.length > LOG_DISPLAY_LIMIT;
    const displayEntries = entries.slice(0, LOG_DISPLAY_LIMIT);
    const refs = await loadActivityLogRefs(displayEntries);
    return adminGlobalActivityLogPage(displayEntries, truncated, session, refs);
  },
);

/** The owner dismissed the welcome steps: store it for the site, so no later
 *  login shows the message again. Owner-only, with the form CSRF check in
 *  `formPost`. */
const handleWelcomeDismiss = formPost(OWNER_FORM)(async () => {
  await settings.update.welcomeDismissed(true);
  return redirect("/admin", t("admin.dashboard.welcome.dismissed"), true);
});

export const adminHandlers = defineRoutes({
  "GET /admin": handleAdminGet,
  "GET /admin/listings": handleAdminListingsGet,
  "GET /admin/listings/csv": handleListingsCsvExport,
  "GET /admin/log": handleAdminLog,
  "POST /admin/welcome/dismiss": handleWelcomeDismiss,
});
