/**
 * Listing attendee CSV export (GET /admin/listing/:id/export).
 *
 * Mirrors the on-screen attendee table — same date filter and check-in
 * filter — then renders the rows (with question answers) as CSV.
 */

/* jscpd:ignore-start */
import { csvResponse, listingAttendeesLoader } from "#routes/admin/actions.ts";
import { generateAttendeesCsv } from "#routes/admin/attendees-csv.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import {
  type AttendeeFilter,
  completePaymentAttendees,
  filterAttendees,
} from "#templates/admin/listings.tsx";
import {
  filteredAttendeesHandler,
  loadListingQuestionData,
} from "./listings-view.ts";

/* jscpd:ignore-end */

/** Parse the ?checkin= filter on the export route, defaulting to "all". */
const checkinFromRequest = (request: Request): AttendeeFilter => {
  const raw = getSearchParam(request, "checkin");
  return raw === "in" || raw === "out" ? raw : "all";
};

/**
 * Handle GET /admin/listing/:id/export (CSV export)
 */
export const handleAdminListingExport: TypedRouteHandler<
  "GET /admin/listing/:id/export"
> = (request, { id }) =>
  listingAttendeesLoader(
    request,
    id,
  )(
    filteredAttendeesHandler(
      request,
      async ({ listing, dateFilter, filteredByDate }) => {
        const isDaily = listing.listing_type === "daily";
        // Mirror the on-screen attendee table: drop the failed-payment rows
        // that are split into the Failed Payments section, then apply the
        // /in /out check-in filter.
        const exported = filterAttendees(
          completePaymentAttendees(listing, filteredByDate),
          checkinFromRequest(request),
        );

        const attendeeIds = exported.map((a) => a.id);
        const questionData = await loadListingQuestionData(
          listing.id,
          attendeeIds,
        );

        const csv = generateAttendeesCsv(
          exported,
          isDaily,
          {
            listingDate: listing.date,
            listingLocation: listing.location,
          },
          questionData,
          settings.timezone,
        );
        const sanitizedName = listing.name.replace(/[^a-zA-Z0-9]/g, "_");
        const filename = dateFilter
          ? `${sanitizedName}_${dateFilter}_attendees.csv`
          : `${sanitizedName}_attendees.csv`;
        await logActivity(
          `CSV exported for '${listing.name}'${
            dateFilter ? ` (date: ${dateFilter})` : ""
          }`,
          listing,
        );
        return csvResponse(csv, filename);
      },
    ),
  );
