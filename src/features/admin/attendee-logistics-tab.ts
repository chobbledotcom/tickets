/**
 * Data loaders for the attendee Logistics tab: the address + pinned-location
 * form values, the logistics start/end selectors, and the "Other Attendees"
 * list of bookings on the same dates.
 *
 * GET renders through the attendee entity page (attendee-page.ts); the POST
 * lives in attendee-logistics-routes.ts. This module is the seam between
 * them, so neither imports the other — the same split the Edit tab uses
 * (attendee-page-data.ts / attendee-form-routes.ts).
 */

import { unique } from "#fp";
import {
  type AttendeeLogisticsTabData,
  buildAttendeeLogisticsData,
  type LogisticsFormErrors,
  type LogisticsFormValues,
} from "#routes/admin/attendee-logistics.ts";
import {
  buildEditFormFromAttendee,
  getRenderListings,
  type LoadedAttendee,
  loadPackagePaths,
} from "#routes/admin/attendee-page-data.ts";
import {
  getOverlappingBookings,
  type OverlappingBooking,
} from "#shared/db/attendees/overlap.ts";
import { getAttendeeNamesByIds } from "#shared/db/attendees/queries.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { AttendeeLogisticsPanel } from "#templates/admin/attendee-logistics-tab.tsx";

/** Rebuild the attendee's form lines from their stored bookings — the same
 * lines the Edit tab renders, reused here so the logistics selectors cover
 * exactly the delivered listings. */
export const storedFormLines = async (entity: LoadedAttendee) => {
  const renderListings = await getRenderListings(entity.existing);
  return buildEditFormFromAttendee(
    entity.attendee,
    entity.existing,
    renderListings,
    await loadPackagePaths(),
  ).parsed.lines;
};

/** One booked window as [startAt, endAt) timestamps. */
export type BookedInterval = { startAt: string; endAt: string };

/** The attendee's real dated booking windows (quantity > 0 only). */
export const bookedIntervals = (entity: LoadedAttendee): BookedInterval[] =>
  entity.existing
    .map(({ booking }) => booking)
    .filter((booking) => booking.quantity > 0 && booking.start_at !== null)
    .map((booking) => ({ endAt: booking.end_at!, startAt: booking.start_at! }));

/** Whether a booking's [start_at, end_at) range overlaps any of the windows —
 * the same predicate the SQL uses, re-applied per window so a gap between two
 * bookings never counts as booked. */
export const overlapsAnyInterval = (
  intervals: BookedInterval[],
  row: { start_at: string; end_at: string },
): boolean =>
  intervals.some(
    (interval) =>
      row.start_at < interval.endAt && row.end_at > interval.startAt,
  );

/** Load and label the other attendees booked on overlapping dates. One query
 * bounded to the whole booked span, then filtered to the actual windows — an
 * attendee booked only in a gap between this attendee's bookings never
 * appears. */
const loadOtherAttendees = async (
  entity: LoadedAttendee,
): Promise<AttendeeLogisticsTabData["others"]> => {
  const intervals = bookedIntervals(entity);
  if (intervals.length === 0) return [];
  const starts = intervals.map((interval) => interval.startAt).sort();
  const ends = intervals.map((interval) => interval.endAt).sort();
  const rows = (
    await getOverlappingBookings(
      entity.attendee.id,
      starts[0]!,
      ends[ends.length - 1]!,
    )
  ).filter((row) => overlapsAnyInterval(intervals, row));
  if (rows.length === 0) return [];
  const names = await getAttendeeNamesByIds(
    unique(rows.map((row) => row.attendee_id)),
    await requireRequestPrivateKey(),
  );
  const listingNames = new Map(
    (await getAllListings()).map((listing) => [listing.id, listing.name]),
  );
  return rows.map((row: OverlappingBooking) => ({
    attendeeId: row.attendee_id,
    endAt: row.end_at,
    endTime: row.end_time,
    listingName: listingNames.get(row.listing_id)!,
    name: names.get(row.attendee_id)!,
    quantity: row.quantity,
    startAt: row.start_at,
    startTime: row.start_time,
  }));
};

/** Build the panel data from stored (GET) or submitted (failed POST) values. */
export const buildLogisticsTabData = async (
  entity: LoadedAttendee,
  values: LogisticsFormValues,
  errors: LogisticsFormErrors,
): Promise<AttendeeLogisticsTabData> => ({
  attendee: entity.attendee,
  logistics: await buildAttendeeLogisticsData(
    await storedFormLines(entity),
    entity.attendee,
  ),
  others: await loadOtherAttendees(entity),
  values,
  ...errors,
});

/** Build the Logistics tab's panel for the entity page (GET path). */
export const loadLogisticsPanel = async (
  entity: LoadedAttendee,
): Promise<JSX.Element> =>
  AttendeeLogisticsPanel({
    data: await buildLogisticsTabData(
      entity,
      {
        address: entity.attendee.address,
        lat: entity.attendee.lat,
        lng: entity.attendee.lng,
      },
      { addressError: null, locationError: null },
    ),
  });
