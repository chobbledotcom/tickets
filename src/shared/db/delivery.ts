/**
 * Delivery assignment reads/writes.
 *
 * Drop-off and collection agents are stored per booking line on
 * `listing_attendees`; the per-attendee `split_delivery_agents` flag records
 * whether the operator entered one pair for the whole order (the common case)
 * or a distinct pair per delivered listing. These helpers keep the SQL for
 * that in one place, separate from the core attendee create/edit machinery.
 */

import { executeBatch, inPlaceholders, queryAll } from "#shared/db/client.ts";

/** A drop-off + collection agent pair (null = unassigned). */
export type DeliveryAssignment = {
  dropOffAgentId: number | null;
  collectionAgentId: number | null;
};

/** A booking's delivery assignment, keyed by listing. */
export type BookingDeliveryAssignment = DeliveryAssignment & {
  attendeeId: number;
  listingId: number;
};

type AssignmentRow = {
  attendee_id: number;
  listing_id: number;
  drop_off_agent_id: number | null;
  collection_agent_id: number | null;
};

/** Build the stable key used to look up a booking's assignment. */
export const bookingAssignmentKey = (
  attendeeId: number,
  listingId: number,
): string => `${attendeeId}|${listingId}`;

/**
 * Persist an attendee's delivery assignments: the split flag plus, for each
 * listed listing, the drop-off/collection agents on its booking row(s). A
 * listing absent from the map is left untouched. Runs as a single batch.
 */
export const setDeliveryAssignments = async (
  attendeeId: number,
  split: boolean,
  perListing: Map<number, DeliveryAssignment>,
): Promise<void> => {
  const statements = [
    {
      args: [split ? 1 : 0, attendeeId],
      sql: "UPDATE attendees SET split_delivery_agents = ? WHERE id = ?",
    },
    ...Array.from(perListing.entries()).map(([listingId, assignment]) => ({
      args: [
        assignment.dropOffAgentId,
        assignment.collectionAgentId,
        attendeeId,
        listingId,
      ],
      sql: `UPDATE listing_attendees
            SET drop_off_agent_id = ?, collection_agent_id = ?
            WHERE attendee_id = ? AND listing_id = ?`,
    })),
  ];
  await executeBatch(statements);
};

/** Read an attendee's per-listing delivery assignments (for the edit form). */
export const getDeliveryAssignments = async (
  attendeeId: number,
): Promise<Map<number, DeliveryAssignment>> => {
  const rows = await queryAll<AssignmentRow>(
    `SELECT listing_id, drop_off_agent_id, collection_agent_id
     FROM listing_attendees WHERE attendee_id = ?`,
    [attendeeId],
  );
  return new Map(
    rows.map((row) => [
      row.listing_id,
      {
        collectionAgentId: row.collection_agent_id,
        dropOffAgentId: row.drop_off_agent_id,
      },
    ]),
  );
};

/**
 * Read the delivery assignments for a set of attendees, one entry per booking
 * line. Used by the calendar agent filter, which matches on either the
 * drop-off or the collection agent. Empty input yields no query.
 */
export const getDeliveryAssignmentsForAttendees = async (
  attendeeIds: number[],
): Promise<BookingDeliveryAssignment[]> => {
  if (attendeeIds.length === 0) return [];
  const rows = await queryAll<AssignmentRow>(
    `SELECT attendee_id, listing_id, drop_off_agent_id, collection_agent_id
     FROM listing_attendees WHERE attendee_id IN (${inPlaceholders(attendeeIds)})`,
    attendeeIds,
  );
  return rows.map((row) => ({
    attendeeId: row.attendee_id,
    collectionAgentId: row.collection_agent_id,
    dropOffAgentId: row.drop_off_agent_id,
    listingId: row.listing_id,
  }));
};

/** Clear every booking reference to an agent (used before deleting it). */
export const clearDeliveryAgentReferences = async (
  agentId: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [agentId],
      sql: "UPDATE listing_attendees SET drop_off_agent_id = NULL WHERE drop_off_agent_id = ?",
    },
    {
      args: [agentId],
      sql: "UPDATE listing_attendees SET collection_agent_id = NULL WHERE collection_agent_id = ?",
    },
  ]);
};
