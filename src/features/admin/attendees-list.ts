/**
 * Admin attendees browser — a paginated, filterable list of every attendee
 * booking across all listings. Read-only; per-attendee actions live on the
 * listing detail and attendee edit pages.
 */

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
import { logActivity } from "#shared/db/activity-log.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeesPage } from "#shared/db/attendees/queries.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { loadNotesForAttendees } from "#shared/db/notes/queries.ts";
import { settings } from "#shared/db/settings.ts";
import { type ListingFilter, listingCategory } from "#shared/listing-filter.ts";
import { readAllPages } from "#shared/paged-read.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { sortListings } from "#shared/sort-listings.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { adminAttendeesListPage } from "#templates/admin/attendees-list.tsx";

/** The browser's controls: every listing, the type filter, sort (newest first
 *  unless the address says otherwise), and paging. */
const browserListSetup = (
  listings: ListingWithCount[],
): AttendeeListSetup<AttendeeSort> => ({
  basePath: adminPattern("attendees"),
  csvPath: "/admin/attendees/csv",
  dates: [],
  defaultSort: "newest",
  listings,
  withCheckin: false,
  withDates: false,
  withPaging: true,
  withTypes: true,
});

/**
 * The listings the page is restricted to: a specific selected listing wins;
 * otherwise a chosen type expands to every listing of that type; otherwise null
 * (all listings). An empty array (a type with no listings) shows nothing.
 */
const resolveListingIds = (
  listingId: number | null,
  type: ListingFilter,
  listings: ListingWithCount[],
): number[] | null => {
  if (listingId !== null) return [listingId];
  if (type === "all") return null;
  return listings.filter((e) => listingCategory(e) === type).map((e) => e.id);
};

/** The browser's whole query: its controls over every listing, the visitor's
 *  choices, and the listings those choices restrict the page to. */
type BrowserList = {
  setup: AttendeeListSetup<AttendeeSort>;
  state: AttendeeListState<AttendeeSort>;
  listingIds: number[] | null;
};

/** Auth, load every listing, and read the visitor's choices — the start both
 * the attendees page and its CSV export share. */
const withBrowserList = (
  request: Request,
  handler: (session: AuthSession, list: BrowserList) => Promise<Response>,
): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const listings = await getAllListings();
    const setup = browserListSetup(listings);
    const state = readAttendeeListState(
      setup,
      new URL(request.url).searchParams,
    );
    return handler(session, {
      listingIds: resolveListingIds(state.listingId, state.type, listings),
      setup,
      state,
    });
  });

/**
 * Handle GET /admin/attendees
 *
 * Renders one page of attendee bookings — newest first by default — with a
 * listing filter and sort order. The fixed page size lives in the query.
 */
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
 * the export isn't paginated. Reuses the page query, so the all-listings case
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

/**
 * Handle GET /admin/attendees/csv
 *
 * Export every attendee booking matching the current listing/type filter — not
 * just the visible page — as a CSV download. Reuses the calendar CSV generator
 * since both list attendees (with their listing) across multiple listings.
 */
export const handleAttendeesCsvExport: TypedRouteHandler<
  "GET /admin/attendees/csv"
> = (request) =>
  withBrowserList(request, async (_session, { setup, listingIds }) => {
    const privateKey = await requireRequestPrivateKey();
    const raw = await allAttendeeBookings(listingIds);
    // Keep one CSV row per booking on the FILTERED listings only: the page
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
