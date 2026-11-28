/**
 * Agents are stored per booking line. The per-attendee
 * `split_logistics_agents` flag records whether the operator entered one pair
 * for the whole order or a distinct pair per delivered listing.
 *
 * Run-sheet reads live next door in `logistics-run-sheet.ts`.
 */

import { executeBatch, queryAll } from "#db/client.ts";
import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { update } from "#db/write.ts";

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

/** Map query rows that each carry an `attendee_id`/`listing_id` pair into a
 * result that always begins with those two camelCase fields plus caller-
 * supplied extras. Shared with `logistics-run-sheet.ts` so the booking-ref
 * prefix cannot drift between the assignment read and the run-sheet read. */
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
    update(tables.attendees, { splitLogisticsAgents: split ? 1 : 0 }).where({
      id: attendeeId,
    }),
    ...Array.from(perListing.entries()).map(([listingId, assignment]) =>
      update(tables.listing_attendees, {
        endAgentId: assignment.endAgentId,
        endTime: assignment.endTime,
        startAgentId: assignment.startAgentId,
        startTime: assignment.startTime,
      }).where({ attendeeId, listingId }),
    ),
  ];
  await executeBatch(statements);
};

/** Read an attendee's per-listing logistics assignments (for the edit form). */
export const getLogisticsAssignments = async (
  attendeeId: number,
): Promise<Map<number, LogisticsAssignment>> =>
  new Map(
    (
      await queryAll(
        from(tables.listing_attendees)
          .where({ attendeeId })
          .pick(
            "listingId",
            "startAgentId",
            "endAgentId",
            "startTime",
            "endTime",
          ),
      )
    ).map(({ listingId, ...assignment }) => [listingId, assignment]),
  );

/**
 * Read the logistics assignments for a set of attendees, one entry per booking
 * line. Used by the calendar agent filter, which matches on either the
 * drop-off or the collection agent. Empty input yields no query.
 */
export const getLogisticsAssignmentsForAttendees = (
  attendeeIds: number[],
): Promise<BookingLogisticsAssignment[]> =>
  readRows(
    from(tables.listing_attendees)
      .where({ attendeeId: attendeeIds })
      .pick(
        "attendeeId",
        "listingId",
        "startAgentId",
        "endAgentId",
        "startTime",
        "endTime",
      ),
  );

/** Clear every booking reference to an agent (used before deleting it). */
export const clearLogisticsAgentReferences = async (
  agentId: number,
): Promise<void> => {
  await executeBatch([
    update(tables.listing_attendees, { startAgentId: null }).where({
      startAgentId: agentId,
    }),
    update(tables.listing_attendees, { endAgentId: null }).where({
      endAgentId: agentId,
    }),
  ]);
};
