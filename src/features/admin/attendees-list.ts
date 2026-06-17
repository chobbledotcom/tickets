/**
 * Admin attendees browser — a paginated, filterable list of every attendee
 * booking across all listings. Read-only; per-attendee actions live on the
 * listing detail and attendee edit pages.
 */

import { map, unique } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { htmlResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  type AttendeeSort,
  decryptAttendees,
  getAttendeesPage,
} from "#shared/db/attendees.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  isListingFilter,
  listingCategory,
  type ListingFilter,
} from "#shared/listing-filter.ts";
import type {
  Attendee,
  AttendeeTableRow,
  ListingWithCount,
} from "#shared/types.ts";
import {
  parsePositiveInt,
  parsePositiveIntId,
} from "#shared/validation/number.ts";
import { adminAttendeesListPage } from "#templates/admin/attendees-list.tsx";

/** Parse the ?sort= param, defaulting to newest-first */
const parseSort = (request: Request): AttendeeSort =>
  getSearchParam(request, "sort") === "oldest" ? "oldest" : "newest";

/** Parse the ?page= param into a zero-based, non-negative page index */
const parsePage = (request: Request): number => {
  return parsePositiveInt(getSearchParam(request, "page")) ?? 0;
};

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

/** Parse the ?type= filter (a listing category), defaulting to "all". */
const parseType = (request: Request): ListingFilter => {
  const raw = getSearchParam(request, "type");
  return isListingFilter(raw) ? raw : "all";
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

/** Join decrypted attendees with their listing context for the table */
const buildRows = (
  attendees: Attendee[],
  listings: ListingWithCount[],
): AttendeeTableRow[] => {
  const listingById = new Map(listings.map((e) => [e.id, e] as const));
  // Every row comes from an INNER JOIN on listing_attendees, so its listing_id
  // always references a listing present in the (unfiltered) cache.
  return map((attendee: Attendee): AttendeeTableRow => {
    const listing = listingById.get(attendee.listing_id)!;
    return { attendee, listingId: listing.id, listingName: listing.name };
  })(attendees);
};

/**
 * Handle GET /admin/attendees
 *
 * Renders one page of attendee bookings — newest first by default — with a
 * listing filter and sort order. The fixed page size lives in the query.
 */
export const handleAttendeesListGet: TypedRouteHandler<
  "GET /admin/attendees"
> = (request) =>
  requireSessionOr(request, async (session) => {
    const listings = await getAllListings();
    const listingId = parseListingId(request, listings);
    const type = parseType(request);
    const sort = parseSort(request);
    const page = parsePage(request);
    const listingIds = resolveListingIds(listingId, type, listings);

    const privateKey = await requirePrivateKey(session);
    const { rows, hasNext } = await getAttendeesPage({
      listingIds,
      page,
      sort,
    });
    const decrypted = await decryptAttendees(rows, privateKey);
    const built = buildRows(decrypted, listings);

    return htmlResponse(
      adminAttendeesListPage({
        allowedDomain: getEffectiveDomain(),
        categories: unique(map(listingCategory)(listings)),
        count: built.length,
        hasNext,
        listingId,
        listings,
        page,
        phonePrefix: settings.phonePrefix,
        rows: built,
        session,
        sort,
        type,
      }),
    );
  });
