/**
 * Admin attendees browser — a paginated, filterable list of every attendee
 * booking across all listings. Read-only; per-attendee actions live on the
 * listing detail and attendee edit pages.
 */

import { fieldById, filter, map, unique } from "#fp";
import { csvResponse } from "#routes/admin/actions.ts";
import {
  generateCalendarCsv,
  toCalendarAttendees,
} from "#routes/admin/calendar-csv.ts";
import { type AuthSession, requireSessionOr } from "#routes/auth.ts";
/* jscpd:ignore-start */
import { htmlResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { groupAttendeeRows } from "#shared/attendee-table-rows.ts";
/* jscpd:ignore-end */
import { getEffectiveDomain } from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import {
  type AttendeeSort,
  getAttendeesPage,
  isAttendeeSort,
} from "#shared/db/attendees/queries.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { loadNotesForAttendees } from "#shared/db/system-notes.ts";
import {
  type ListingFilter,
  listingCategory,
  listingTypeFromRequest,
} from "#shared/listing-filter.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { sortListings } from "#shared/sort-listings.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import {
  parsePositiveInt,
  parsePositiveIntId,
} from "#shared/validation/number.ts";
import { adminAttendeesListPage } from "#templates/admin/attendees-list.tsx";

/** Parse the ?sort= param, defaulting to newest-first. Validates against the
 *  {@link AttendeeSort} picklist so the URL is the single source of valid sort
 *  values — no second hand-listed `=== "oldest"` here. */
const parseSort = (request: Request): AttendeeSort => {
  const raw = getSearchParam(request, "sort");
  return raw !== null && isAttendeeSort(raw) ? raw : "newest";
};

/** Parse the ?page= param into a zero-based, non-negative page index */
const parsePage = (request: Request): number =>
  parsePositiveInt(getSearchParam(request, "page")) ?? 0;

/**
 * Parse the ?listing= filter. Returns the listing id only when it matches a
 * known listing, otherwise null (the "all listings" view). Validating against
 * the known set keeps the selected dropdown option and the query in sync.
 */
const parseListingId = (
  request: Request,
  listings: ListingWithCount[],
): number | null => {
  const raw = parsePositiveIntId(getSearchParam(request, "listing"));
  if (raw === null) return null;
  return listings.some((e) => e.id === raw) ? raw : null;
};

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

/** Auth, then load every listing and hand both to the handler. Shared by the
 * attendees page and its CSV export, which both start from the full set. */
const withListings = (
  request: Request,
  handler: (
    session: AuthSession,
    listings: ListingWithCount[],
  ) => Promise<Response>,
): Promise<Response> =>
  requireSessionOr(request, async (session) =>
    handler(session, await getAllListings()),
  );

/**
 * Handle GET /admin/attendees
 *
 * Renders one page of attendee bookings — newest first by default — with a
 * listing filter and sort order. The fixed page size lives in the query.
 */
export const handleAttendeesListGet: TypedRouteHandler<
  "GET /admin/attendees"
> = (request) =>
  withListings(request, async (session, listings) => {
    const listingId = parseListingId(request, listings);
    const type = listingTypeFromRequest(request);
    const sort = parseSort(request);
    const page = parsePage(request);
    const listingIds = resolveListingIds(listingId, type, listings);

    const [privateKey, holidays] = await Promise.all([
      requireRequestPrivateKey(),
      getActiveHolidays(),
    ]);
    const { rows, hasNext } = await getAttendeesPage({
      listingIds,
      page,
      sort,
    });
    const decrypted = await decryptAttendees(rows, privateKey);
    // One row per attendee, its listings in the same display order as the
    // listings page (sortListings decides that order for both).
    const built = groupAttendeeRows(
      decrypted,
      sortListings(listings, holidays),
    );
    const attendeeIds = unique(decrypted.map((a) => a.id));
    const systemNotes = await loadNotesForAttendees(attendeeIds, () =>
      Promise.resolve(privateKey),
    );

    return htmlResponse(
      adminAttendeesListPage({
        allowedDomain: getEffectiveDomain(),
        categories: unique(map(listingCategory)(listings)),
        count: built.length,
        hasNext,
        listingId,
        listings,
        names: fieldById("name")(decrypted),
        page,
        phonePrefix: settings.phonePrefix,
        rows: built,
        session,
        sort,
        systemNotes,
        type,
      }),
    );
  });

/** Every booking row of every attendee matching the filter, across all pages —
 * the export isn't paginated. Reuses the page query, so the all-listings case
 * (null) stays an unfiltered query rather than an enormous `IN (...)` clause.
 * Note the page query matches ATTENDEES: a filtered call also returns a matched
 * attendee's bookings on other listings — the CSV handler re-narrows. */
const allAttendeeBookings = async (
  listingIds: number[] | null,
): Promise<Attendee[]> => {
  const out: Attendee[] = [];
  let page = 0;
  let hasNext = true;
  while (hasNext) {
    const result = await getAttendeesPage({ listingIds, page, sort: "newest" });
    for (const row of result.rows) out.push(row);
    hasNext = result.hasNext;
    page++;
  }
  return out;
};

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
  withListings(request, async (_session, listings) => {
    const listingIds = resolveListingIds(
      parseListingId(request, listings),
      listingTypeFromRequest(request),
      listings,
    );
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
      toCalendarAttendees(attendees, listings),
      undefined,
      settings.timezone,
    );
    await logActivity("Attendees CSV exported");
    return csvResponse(csv, "attendees.csv");
  });
