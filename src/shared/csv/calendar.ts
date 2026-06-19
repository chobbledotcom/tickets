/**
 * Calendar CSV export: attendees across multiple listings (one row per
 * booking), prefixed with the listing name and, when present, listing
 * date/location. When a logistics run-sheet context is supplied and any row
 * belongs to a logistics listing, start/end agent + time columns and
 * Google/Apple map links are appended.
 */

import { t } from "#i18n";
import {
  attendeeCols,
  attendeeHeaders,
  buildCsv,
  csvDateRange,
  listingInfoCols,
  listingInfoHeaders,
} from "#shared/csv/attendee-columns.ts";
import { escapeCsvValue } from "#shared/csv/core.ts";
import {
  bookingAssignmentKey,
  type LogisticsAssignment,
} from "#shared/db/logistics.ts";
import { appleMapsUrl, googleMapsUrl } from "#shared/maps.ts";
import type { Attendee } from "#shared/types.ts";

/** Attendee with associated listing info for calendar CSV */
export type CalendarAttendee = Attendee & {
  listingName: string;
  listingDate: string;
  listingLocation: string;
};

/**
 * Logistics run-sheet context for the calendar CSV. When provided and at least
 * one exported booking belongs to a logistics listing, the CSV gains start/end
 * agent + time columns and Google/Apple map links for the attendee's address.
 */
export type CalendarLogisticsCsv = {
  /** Listing ids that use logistics (only these rows get the extra columns). */
  listingIds: Set<number>;
  /** Agent id → display name. */
  agentNames: Map<number, string>;
  /** `${attendeeId}|${listingId}` → that booking's assignment. */
  assignments: Map<string, LogisticsAssignment>;
};

/**
 * Join attendees with their listings into calendar CSV rows, taking the
 * listing name and date/location from the attendee's `listing_id`. Callers
 * guarantee every attendee's listing is present in `listings`.
 */
export const toCalendarAttendees = <
  L extends { id: number; name: string; date: string; location: string },
>(
  attendees: readonly Attendee[],
  listings: readonly L[],
): CalendarAttendee[] => {
  const byId = new Map(listings.map((l) => [l.id, l] as const));
  return attendees.map((a) => {
    const listing = byId.get(a.listing_id)!;
    return {
      ...a,
      listingDate: listing.date,
      listingLocation: listing.location,
      listingName: listing.name,
    };
  });
};

const LOGISTICS_HEADERS =
  "Start Agent,Start Time,End Agent,End Time,Map (Google),Map (Apple)";

/** The six logistics columns for one booking row, or six blanks when the row's
 * listing isn't a logistics listing. */
const logisticsCols = (
  a: CalendarAttendee,
  logistics: CalendarLogisticsCsv,
): string[] => {
  if (!logistics.listingIds.has(a.listing_id)) {
    return ["", "", "", "", "", ""];
  }
  const assignment = logistics.assignments.get(
    bookingAssignmentKey(a.id, a.listing_id),
  );
  const agentName = (id: number | null | undefined): string =>
    id == null ? "" : (logistics.agentNames.get(id) ?? "");
  const map = (url: string): string => (a.address ? url : "");
  return [
    escapeCsvValue(agentName(assignment?.startAgentId)),
    escapeCsvValue(assignment?.startTime ?? ""),
    escapeCsvValue(agentName(assignment?.endAgentId)),
    escapeCsvValue(assignment?.endTime ?? ""),
    escapeCsvValue(map(googleMapsUrl(a.address))),
    escapeCsvValue(map(appleMapsUrl(a.address))),
  ];
};

/**
 * Generate CSV content for calendar view (attendees across multiple daily listings).
 * Conditionally includes Listing Date and Listing Location columns based on data.
 * When logistics context is supplied and any row is a logistics booking, also
 * appends start/end agent + time columns and map links (a per-agent run sheet).
 */
export const generateCalendarCsv = (
  attendees: CalendarAttendee[],
  logistics?: CalendarLogisticsCsv,
): string => {
  const showListingDate = attendees.some((a) => a.listingDate !== "");
  const showListingLocation = attendees.some((a) => a.listingLocation !== "");
  const showLogistics = Boolean(
    logistics && attendees.some((a) => logistics.listingIds.has(a.listing_id)),
  );
  const headerParts = [
    escapeCsvValue(t("terms.listing")),
    ...listingInfoHeaders(showListingDate, showListingLocation),
    escapeCsvValue(t("common.date")),
    ...attendeeHeaders(),
    ...(showLogistics ? [LOGISTICS_HEADERS] : []),
  ];
  return buildCsv(
    headerParts.join(","),
    (a: CalendarAttendee, domain) => [
      escapeCsvValue(a.listingName),
      ...listingInfoCols(
        showListingDate,
        showListingLocation,
        a.listingDate,
        a.listingLocation,
      ),
      escapeCsvValue(csvDateRange(a.date, a.end_date)),
      ...attendeeCols(a, domain),
      ...(showLogistics ? logisticsCols(a, logistics!) : []),
    ],
    attendees,
  );
};
