/**
 * Agents are stored per booking line, and the per-attendee
 * `split_logistics_agents` flag records whether the operator entered one pair
 * for the whole order or a distinct pair per delivered listing.
 *
 * Run-sheet reads live next door in `logistics-run-sheet.ts`.
 */

import { executeBatch, inPlaceholders, queryAll, update } from "#db/client.ts";

/** A start/end agent pair (null = unassigned) plus optional start/end times
 * ("" when unset). Times are logistics-only metadata — never used for
 * availability or capacity. */
export type LogisticsAssignment = {
  startAgentId: number | null;
  endAgentId: number | null;
  startTime: string;
  endTime: string;
};

/** A booking's logistics assignment, keyed by listing. */
export type BookingLogisticsAssignment = LogisticsAssignment & {
  attendeeId: number;
  listingId: number;
};

/** A booking row named by the two ids the run sheet uses. */
export type DeliveryBookingRef = {
  attendeeId: number;
  listingId: number;
};

/** The raw `listing_attendees` logistics columns: who/what plus each leg's
 * agent and time. Also the base of the overlap query's rows (overlap.ts). */
export type AssignmentRow = {
  attendee_id: number;
  listing_id: number;
  start_agent_id: number | null;
  end_agent_id: number | null;
  start_time: string;
  end_time: string;
};

/** Map a DB row to the assignment shape (shared by the read helpers). */
const rowToAssignment = (row: AssignmentRow): LogisticsAssignment => ({
  endAgentId: row.end_agent_id,
  endTime: row.end_time,
  startAgentId: row.start_agent_id,
  startTime: row.start_time,
});

/** Map query rows that each carry an `attendee_id`/`listing_id` pair into a
 * result that always begins with those two camelCase fields plus caller-
 * supplied extras. Shared with `logistics-run-sheet.ts` so the booking-ref
 * prefix can't drift between the assignment read and the run-sheet read. */
export const mapBookingRows = <
  Row extends { attendee_id: number; listing_id: number },
  Extra extends Record<string, unknown>,
>(
  rows: readonly Row[],
  extend: (row: Row) => Extra,
): (Extra & { attendeeId: number; listingId: number })[] =>
  rows.map((row) => ({
    attendeeId: row.attendee_id,
    listingId: row.listing_id,
    ...extend(row),
  }));

/** Build the stable key used to look up a booking's assignment. */
export const bookingAssignmentKey = (
  attendeeId: number,
  listingId: number,
): string => `${attendeeId}|${listingId}`;

/**
 * Persist an attendee's logistics assignments: the split flag plus, for each
 * listed listing, the drop-off/collection agents on its booking row(s). A
 * listing absent from the map is left untouched. Runs as a single batch.
 */
export const setLogisticsAssignments = async (
  attendeeId: number,
  split: boolean,
  perListing: Map<number, LogisticsAssignment>,
): Promise<void> => {
  const statements = [
    update(
      "attendees",
      { split_logistics_agents: split ? 1 : 0 },
      { id: attendeeId },
    ),
    ...Array.from(perListing.entries()).map(([listingId, assignment]) =>
      update(
        "listing_attendees",
        {
          end_agent_id: assignment.endAgentId,
          end_time: assignment.endTime,
          start_agent_id: assignment.startAgentId,
          start_time: assignment.startTime,
        },
        { attendee_id: attendeeId, listing_id: listingId },
      ),
    ),
  ];
  await executeBatch(statements);
};

/** Read an attendee's per-listing logistics assignments (for the edit form). */
export const getLogisticsAssignments = async (
  attendeeId: number,
): Promise<Map<number, LogisticsAssignment>> => {
  const rows = await queryAll<AssignmentRow>(
    `SELECT listing_id, start_agent_id, end_agent_id, start_time, end_time
     FROM listing_attendees WHERE attendee_id = ?`,
    [attendeeId],
  );
  return new Map(rows.map((row) => [row.listing_id, rowToAssignment(row)]));
};

/**
 * Read the logistics assignments for a set of attendees, one entry per booking
 * line. Used by the calendar agent filter, which matches on either the
 * drop-off or the collection agent. Empty input yields no query.
 */
export const getLogisticsAssignmentsForAttendees = async (
  attendeeIds: number[],
): Promise<BookingLogisticsAssignment[]> => {
  if (attendeeIds.length === 0) return [];
  const rows = await queryAll<AssignmentRow>(
    `SELECT attendee_id, listing_id, start_agent_id, end_agent_id, start_time, end_time
     FROM listing_attendees WHERE attendee_id IN (${inPlaceholders(attendeeIds)})`,
    attendeeIds,
  );
  return mapBookingRows(rows, rowToAssignment);
};

/** Clear every booking reference to an agent (used before deleting it). */
export const clearLogisticsAgentReferences = async (
  agentId: number,
): Promise<void> => {
  await executeBatch([
    update(
      "listing_attendees",
      { start_agent_id: null },
      { start_agent_id: agentId },
    ),
    update(
      "listing_attendees",
      { end_agent_id: null },
      { end_agent_id: agentId },
    ),
  ]);
};
