import { getDb } from "#db/client.ts";
import {
  type DeliveryBookingRef,
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#db/logistics.ts";
import { addDays } from "#shared/dates.ts";

export const logisticsAgentAssignment = (
  agentId: number,
): LogisticsAssignment => ({
  endAgentId: agentId,
  endTime: "17:00",
  startAgentId: agentId,
  startTime: "09:00",
});

export const setBookingWindow = async (
  attendeeId: number,
  listingId: number,
  startDate: string,
  endDate: string,
): Promise<void> => {
  await getDb().execute({
    args: [
      `${startDate}T00:00:00Z`,
      `${endDate}T00:00:00Z`,
      attendeeId,
      listingId,
    ],
    sql: "UPDATE listing_attendees SET start_at = ?, end_at = ? WHERE attendee_id = ? AND listing_id = ?",
  });
};

export const assignBookingLogistics = async (
  booking: DeliveryBookingRef,
  assignment: LogisticsAssignment,
  startDate: string,
  endDate: string,
): Promise<void> => {
  await setLogisticsAssignments(
    booking.attendeeId,
    false,
    new Map([[booking.listingId, assignment]]),
  );
  await setBookingWindow(
    booking.attendeeId,
    booking.listingId,
    startDate,
    endDate,
  );
};

export const assignBookingToAgent = async (
  attendeeId: number,
  listingId: number,
  agentId: number,
  date: string,
): Promise<void> => {
  await assignBookingLogistics(
    { attendeeId, listingId },
    logisticsAgentAssignment(agentId),
    date,
    addDays(date, 1),
  );
};

/** Insert a SECOND `listing_attendees` row for an attendee/listing pair on a
 * different `start_at` date. The unique slot index is on
 * `(listing_id, attendee_id, start_at, parent_listing_id, package_group_id)`,
 * so a distinct `start_at` makes this a fresh row rather than colliding with
 * the first booking — the same shape an attendee gets by booking the same
 * daily listing twice on different dates. */
export const insertSecondBookingRow = async (
  attendeeId: number,
  listingId: number,
  startDate: string,
  quantity = 1,
): Promise<void> => {
  await getDb().execute({
    args: [listingId, attendeeId, quantity, `${startDate}T00:00:00Z`],
    sql: `INSERT INTO listing_attendees
            (listing_id, attendee_id, quantity, start_at)
          VALUES (?, ?, ?, ?)`,
  });
};
