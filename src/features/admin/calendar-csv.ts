/**
 * Calendar CSV export: attendees across multiple listings (one row per
 * booking), prefixed with the listing name and, when present, listing
 * date/location, and — for logistics listings — start/end agent + time columns
 * and map links. Built from the shared attendee columns plus calendar-specific
 * ones and handed to the pure {@link CSV.generate}.
 */

/* jscpd:ignore-start */
import { byId } from "#fp";
import { t } from "#i18n";
import {
  csvDateRange,
  listingInfoColumns,
  pendingCheckoutColumns,
  standardAttendeeColumns,
} from "#routes/admin/attendees-csv.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { type Column, CSV } from "#shared/csv/index.ts";
import { isServicing } from "#shared/db/attendees/kind.ts";
import {
  bookingAssignmentKey,
  type LogisticsAssignment,
} from "#shared/db/logistics.ts";
import { listingDetails } from "#shared/listing-details.ts";
import { appleMapsUrl, googleMapsUrl } from "#shared/maps.ts";
import { formatDatetimeShortInTz } from "#shared/timezone.ts";
import { DEFAULT_TIMEZONE } from "#shared/timezone-default.ts";
import type { Attendee } from "#shared/types.ts";
/* jscpd:ignore-end */

/** Attendee with associated listing info for calendar CSV. */
export type CalendarAttendee = Attendee & {
  listingName: string;
  listingDate: string;
  listingLocation: string;
};

/**
 * Logistics run-sheet context. When provided and at least one exported booking
 * belongs to a logistics listing, the CSV gains start/end agent + time columns
 * and Google/Apple map links for the attendee's address.
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
 * Join attendees with their listings into calendar CSV rows, taking the listing
 * name and date/location from the attendee's `listing_id`. Callers guarantee
 * every attendee's listing is present in `listings`.
 */
export const toCalendarAttendees = <
  L extends { id: number; name: string; date: string; location: string },
>(
  attendees: readonly Attendee[],
  listings: readonly L[],
): CalendarAttendee[] => {
  const listingById = byId(listings);
  return attendees.map((a) => {
    const listing = listingById.get(a.listing_id)!;
    return { ...a, ...listingDetails(listing) };
  });
};

/** The six logistics columns; each is blank for non-logistics bookings. */
const logisticsColumns = (
  logistics: CalendarLogisticsCsv,
): Column<CalendarAttendee>[] => {
  const assignmentOf = (a: CalendarAttendee): LogisticsAssignment | undefined =>
    logistics.assignments.get(bookingAssignmentKey(a.id, a.listing_id));
  const agentName = (id: number | null | undefined): string =>
    id == null ? "" : (logistics.agentNames.get(id) ?? "");
  // Only logistics-listing rows get values; the rest stay blank.
  const onLogistics =
    (cell: (a: CalendarAttendee) => string) =>
    (a: CalendarAttendee): string =>
      logistics.listingIds.has(a.listing_id) ? cell(a) : "";
  const mapLink =
    (url: (address: string) => string) =>
    (a: CalendarAttendee): string =>
      a.address ? url(a.address) : "";
  return [
    {
      header: "Start Agent",
      value: onLogistics((a) => agentName(assignmentOf(a)?.startAgentId)),
    },
    {
      header: "Start Time",
      value: onLogistics((a) => assignmentOf(a)?.startTime ?? ""),
    },
    {
      header: "End Agent",
      value: onLogistics((a) => agentName(assignmentOf(a)?.endAgentId)),
    },
    {
      header: "End Time",
      value: onLogistics((a) => assignmentOf(a)?.endTime ?? ""),
    },
    { header: "Map (Google)", value: onLogistics(mapLink(googleMapsUrl)) },
    { header: "Map (Apple)", value: onLogistics(mapLink(appleMapsUrl)) },
  ];
};

/** The row's type label for the calendar CSV: "Service event" for a servicing
 *  hold, "Attendee" for a real customer. Servicing rows carry blank contact
 *  fields (and no followable ticket URL), so the Type column is what makes a
 *  hold readable in the run sheet instead of looking like a customer with
 *  missing data. */
const typeLabel = (a: CalendarAttendee): string =>
  isServicing(a.kind) ? "Service event" : "Attendee";

/** The ordered calendar columns: Type, Listing name, optional listing date/location,
 * the booking Date, the standard attendee columns, then — when a run-sheet
 * context applies to any row — the logistics columns. Pure; built per call so
 * the active locale applies. */
const calendarColumns = ({
  attendees,
  domain,
  tz,
  logistics,
}: {
  attendees: CalendarAttendee[];
  domain: string;
  tz: string;
  logistics?: CalendarLogisticsCsv | undefined;
}): Column<CalendarAttendee>[] => {
  const showLogistics = Boolean(
    logistics && attendees.some((a) => logistics.listingIds.has(a.listing_id)),
  );
  return [
    { header: t("terms.listing"), value: (a) => a.listingName },
    { header: "Type", value: typeLabel },
    ...listingInfoColumns<CalendarAttendee>(
      {
        show: attendees.some((a) => a.listingDate !== ""),
        value: (a) =>
          a.listingDate ? formatDatetimeShortInTz(a.listingDate, tz) : "",
      },
      {
        show: attendees.some((a) => a.listingLocation !== ""),
        value: (a) => a.listingLocation,
      },
    ),
    {
      header: t("common.date"),
      value: (a) => csvDateRange(a.date, a.end_date),
    },
    ...standardAttendeeColumns(domain),
    ...pendingCheckoutColumns(attendees),
    ...(showLogistics ? logisticsColumns(logistics!) : []),
  ];
};

/**
 * Generate CSV content for the calendar view. Conditionally includes Listing
 * Date / Listing Location columns based on the data, and the logistics columns
 * when a run-sheet context is supplied and any row is a logistics booking. The
 * Listing Date is rendered in `tz`.
 */
export const generateCalendarCsv = (
  attendees: CalendarAttendee[],
  logistics?: CalendarLogisticsCsv,
  tz: string = DEFAULT_TIMEZONE,
): string =>
  CSV.generate(
    attendees,
    calendarColumns({ attendees, domain: getEffectiveDomain(), logistics, tz }),
  );
