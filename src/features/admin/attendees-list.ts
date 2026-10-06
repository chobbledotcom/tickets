/**
 * Admin attendees browser — a paginated, filterable list of every attendee
 * booking across all listings. Read-only. Per-attendee actions live on the
 * listing detail and attendee edit pages.
 */

/* jscpd:ignore-start -- imports */
import { logActivity } from "#db/activity-log.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesPage } from "#db/attendees/queries.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import { loadNotesForAttendees } from "#db/notes/queries.ts";
import { settings } from "#db/settings.ts";
import { fieldById, filter, unique } from "#fp";
import { csvResponse } from "#routes/admin/actions.ts";
import {
  generateCalendarCsv,
  toCalendarAttendees,
} from "#routes/admin/calendar-csv.ts";
import { type AuthSession, requireSessionOr } from "#routes/auth.ts";
/* jscpd:ignore-start */
import { htmlResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
/* jscpd:ignore-end */
import {
  type AttendeeListSetup,
  type AttendeeListState,
  type AttendeeSort,
  readAttendeeListState,
} from "#shared/attendee-list-controls.ts";
import { groupAttendeeRows } from "#shared/attendee-table-rows.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  groupScopeOptions,
  type LedgerScopeOption,
} from "#shared/ledger-scope.ts";
import {
  intersectListingIds,
  type ListingFilter,
  listingCategory,
} from "#shared/listing-filter.ts";
import { readAllPages } from "#shared/paged-read.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  groupMemberIds,
  loadListingsAndGroupNames,
  sortListings,
} from "#shared/sort-listings.ts";
import { adminAttendeesListPage } from "#templates/admin/attendees-list.tsx";
import type { Attendee, ListingWithCount } from "#types";

/* jscpd:ignore-end */

/** The browser's controls: every listing, every group, the type filter, sort
 *  (newest first unless the address says otherwise), and paging. */
const browserListSetup = (
  listings: ListingWithCount[],
  groups: LedgerScopeOption[],
): AttendeeListSetup<AttendeeSort> => ({
  basePath: adminPattern("attendees"),
  csvPath: "/admin/attendees/csv",
  dates: [],
  defaultSort: "newest",
  groups,
  listings,
  withCheckin: false,
  withDates: false,
  withPaging: true,
  withTypes: true,
});

/** `null` allows every listing. An empty array (a type with no listings)
 *  shows nothing. A chosen group narrows whatever those choices keep to the
 *  group's member listings. One listing outside the group answers the empty
 *  state, and an empty group shows nothing. */
const resolveListingIds = (
  listingId: number | null,
  type: ListingFilter,
  listings: ListingWithCount[],
  memberIds: ReadonlySet<number> | null,
): number[] | null =>
  intersectListingIds(
    resolveListingOrTypeIds(listingId, type, listings),
    memberIds,
  );

const resolveListingOrTypeIds = (
  listingId: number | null,
  type: ListingFilter,
  listings: ListingWithCount[],
): number[] | null => {
  if (listingId !== null) return [listingId];
  if (type === "all") return null;
  return listings.filter((e) => listingCategory(e) === type).map((e) => e.id);
};

type BrowserList = {
  setup: AttendeeListSetup<AttendeeSort>;
  state: AttendeeListState<AttendeeSort>;
  listingIds: number[] | null;
};

/** The start the attendees page and its CSV export share. A chosen group
 * resolves to its member listings through the one shared membership read. */
const withBrowserList = (
  request: Request,
  handler: (session: AuthSession, list: BrowserList) => Promise<Response>,
): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const [listings, groups] = await loadListingsAndGroupNames();
    const setup = browserListSetup(listings, groupScopeOptions(groups));
    const state = readAttendeeListState(
      setup,
      new URL(request.url).searchParams,
    );
    const memberIds =
      state.groupId === null ? null : await groupMemberIds(state.groupId);
    return handler(session, {
      listingIds: resolveListingIds(
        state.listingId,
        state.type,
        listings,
        memberIds,
      ),
      setup,
      state,
    });
  });

/** The fixed page size lives in the query. */
export const handleAttendeesListGet: TypedRouteHandler<
  "GET /admin/attendees"
> = (request) =>
  withBrowserList(request, async (session, { setup, state, listingIds }) => {
    const [privateKey, holidays] = await Promise.all([
      requireRequestPrivateKey(),
      getActiveHolidays(),
    ]);
    const { rows, hasNext } = await getAttendeesPage({
      listingIds,
      page: state.page,
      sort: state.sort,
    });
    const decrypted = await decryptAttendees(rows, privateKey);
    // One row per attendee, its listings in the same display order as the
    // listings page (sortListings decides that order for both).
    const built = groupAttendeeRows(
      decrypted,
      sortListings(setup.listings, holidays),
    );
    const attendeeIds = unique(decrypted.map((a) => a.id));
    const systemNotes = await loadNotesForAttendees(attendeeIds, () =>
      Promise.resolve(privateKey),
    );

    return htmlResponse(
      adminAttendeesListPage({
        allowedDomain: getEffectiveDomain(),
        hasNext,
        names: fieldById("name")(decrypted),
        phonePrefix: settings.phonePrefix,
        rows: built,
        session,
        setup,
        state,
        systemNotes,
      }),
    );
  });

/** Every booking row of every attendee matching the filter, across all pages —
 * the export is not paginated. Reuses the page query, so the all-listings case
 * (null) stays an unfiltered query rather than an enormous `IN (...)` clause.
 * Note the page query matches ATTENDEES: a filtered call also returns a matched
 * attendee's bookings on other listings — the CSV handler re-narrows. */
/** Hard stop for the export's page walk. More pages than this means the page
 * cursor stopped advancing, not that a site really has this many bookings. */
const MAX_EXPORT_PAGES = 10_000;

const allAttendeeBookings = (
  listingIds: number[] | null,
): Promise<Attendee[]> =>
  readAllPages(MAX_EXPORT_PAGES, (page) =>
    getAttendeesPage({ listingIds, page, sort: "newest" }),
  );

/** Exports every booking that matches the filter, not only the visible page.
 *  The calendar CSV generator serves this export too, because both list
 *  attendees with their listing. */
export const handleAttendeesCsvExport: TypedRouteHandler<
  "GET /admin/attendees/csv"
> = (request) =>
  withBrowserList(request, async (_session, { setup, listingIds }) => {
    const privateKey = await requireRequestPrivateKey();
    const raw = await allAttendeeBookings(listingIds);
    // Keep one CSV row per booking on the FILTERED listings only. The page
    // query returns a matched attendee's other listings too (for the grouped
    // table), which the export must not include.
    const inFilter = listingIds && new Set(listingIds);
    const bookings = inFilter
      ? filter((a: Attendee) => inFilter.has(a.listing_id))(raw)
      : raw;
    const attendees = await decryptAttendees(bookings, privateKey);
    const csv = generateCalendarCsv(
      toCalendarAttendees(attendees, setup.listings),
      undefined,
      settings.timezone,
    );
    await logActivity("Attendees CSV exported");
    return csvResponse(csv, "attendees.csv");
  });
