/**
 * Logistics assignment reads/writes.
 *
 * Drop-off and collection agents are stored per booking line on
 * `listing_attendees`; the per-attendee `split_logistics_agents` flag records
 * whether the operator entered one pair for the whole order (the common case)
 * or a distinct pair per delivered listing. These helpers keep the SQL for
 * that in one place, separate from the core attendee create/edit machinery.
 */

import { executeBatch, inPlaceholders, queryAll } from "#shared/db/client.ts";

/** A drop-off + collection agent pair (null = unassigned). */
export type LogisticsAssignment = {
  startAgentId: number | null;
  endAgentId: number | null;
};

/** A booking's logistics assignment, keyed by listing. */
export type BookingLogisticsAssignment = LogisticsAssignment & {
  attendeeId: number;
  listingId: number;
};

type AssignmentRow = {
  attendee_id: number;
  listing_id: number;
  start_agent_id: number | null;
  end_agent_id: number | null;
};

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
    {
      args: [split ? 1 : 0, attendeeId],
      sql: "UPDATE attendees SET split_logistics_agents = ? WHERE id = ?",
    },
    ...Array.from(perListing.entries()).map(([listingId, assignment]) => ({
      args: [
        assignment.startAgentId,
        assignment.endAgentId,
        attendeeId,
        listingId,
      ],
      sql: `UPDATE listing_attendees
            SET start_agent_id = ?, end_agent_id = ?
            WHERE attendee_id = ? AND listing_id = ?`,
    })),
  ];
  await executeBatch(statements);
};

/** Read an attendee's per-listing logistics assignments (for the edit form). */
export const getLogisticsAssignments = async (
  attendeeId: number,
): Promise<Map<number, LogisticsAssignment>> => {
  const rows = await queryAll<AssignmentRow>(
    `SELECT listing_id, start_agent_id, end_agent_id
     FROM listing_attendees WHERE attendee_id = ?`,
    [attendeeId],
  );
  return new Map(
    rows.map((row) => [
      row.listing_id,
      {
        endAgentId: row.end_agent_id,
        startAgentId: row.start_agent_id,
      },
    ]),
  );
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
    `SELECT attendee_id, listing_id, start_agent_id, end_agent_id
     FROM listing_attendees WHERE attendee_id IN (${inPlaceholders(attendeeIds)})`,
    attendeeIds,
  );
  return rows.map((row) => ({
    attendeeId: row.attendee_id,
    endAgentId: row.end_agent_id,
    listingId: row.listing_id,
    startAgentId: row.start_agent_id,
  }));
};

/** Clear every booking reference to an agent (used before deleting it). */
export const clearLogisticsAgentReferences = async (
  agentId: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [agentId],
      sql: "UPDATE listing_attendees SET start_agent_id = NULL WHERE start_agent_id = ?",
    },
    {
      args: [agentId],
      sql: "UPDATE listing_attendees SET end_agent_id = NULL WHERE end_agent_id = ?",
    },
  ]);
};
