import { addDays } from "#shared/dates.ts";
import { getDb } from "#shared/db/client.ts";
import {
  type DeliveryBookingRef,
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";

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
