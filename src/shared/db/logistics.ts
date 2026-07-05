/**
 * Logistics assignment reads/writes.
 *
 * Drop-off and collection agents are stored per booking line on
 * `listing_attendees`; the per-attendee `split_logistics_agents` flag records
 * whether the operator entered one pair for the whole order (the common case)
 * or a distinct pair per delivered listing. These helpers keep the SQL for
 * that in one place, separate from the core attendee create/edit machinery.
 */

import { compact, flatMap } from "#fp";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
} from "#shared/db/client.ts";

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

type AssignmentRow = {
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
        assignment.startTime,
        assignment.endTime,
        attendeeId,
        listingId,
      ],
      sql: `UPDATE listing_attendees
            SET start_agent_id = ?, end_agent_id = ?, start_time = ?, end_time = ?
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
  return rows.map((row) => ({
    attendeeId: row.attendee_id,
    listingId: row.listing_id,
    ...rowToAssignment(row),
  }));
};

/** Which leg of a delivery a run-sheet entry represents. */
export type DeliveryLegKind = "start" | "end";

/** One leg of a booking on an agent's run sheet: a drop-off (`start`) or a
 * collection (`end`) for a single logistics agent on a single calendar date. */
export type AgentRunLeg = {
  kind: DeliveryLegKind;
  attendeeId: number;
  listingId: number;
  agentId: number;
  /** Calendar date of this leg (YYYY-MM-DD): the drop-off date for a `start`
   * leg, and the last booked day (`end_at - 1 day`) for an `end` leg. */
  date: string;
  /** Logistics time label ("" when unset). */
  time: string;
  done: boolean;
};

type RunSheetRow = AssignmentRow & {
  start_done: number;
  end_done: number;
  start_date: string | null;
  end_date: string | null;
};

/** Build the run-sheet leg of one `kind` for a row, or null when that leg's
 * agent or date falls outside the requested sets. */
const buildLeg = (
  row: RunSheetRow,
  kind: DeliveryLegKind,
  agentSet: Set<number>,
  dateSet: Set<string>,
): AgentRunLeg | null => {
  const isStart = kind === "start";
  const agentId = isStart ? row.start_agent_id : row.end_agent_id;
  const date = isStart ? row.start_date : row.end_date;
  if (agentId === null || !agentSet.has(agentId)) return null;
  if (date === null || !dateSet.has(date)) return null;
  return {
    agentId,
    attendeeId: row.attendee_id,
    date,
    done: (isStart ? row.start_done : row.end_done) === 1,
    kind,
    listingId: row.listing_id,
    time: isStart ? row.start_time : row.end_time,
  };
};

/**
 * Load the run-sheet legs for a set of logistics agents on the given calendar
 * dates. A booking contributes a `start` leg when its drop-off agent is one of
 * `agentIds` and its drop-off date is in `dates`, and likewise an `end` leg for
 * collection. Empty input yields no query.
 *
 * `end_at` is the exclusive end of the booked window (the first midnight after
 * it), so the collection happens on the *last booked day*, `end_at - 1 day`.
 * That makes a one-day hire collected the same day it is dropped off, a two-day
 * hire collected the next day, and so on. (Availability is unaffected: a hire
 * still occupies the listing for its whole `[start_at, end_at)` span.)
 */
export const getAgentRunSheet = async (
  agentIds: number[],
  dates: string[],
): Promise<AgentRunLeg[]> => {
  if (agentIds.length === 0 || dates.length === 0) return [];
  const agentPlaceholders = inPlaceholders(agentIds);
  const datePlaceholders = inPlaceholders(dates);
  const rows = await queryAll<RunSheetRow>(
    `SELECT attendee_id, listing_id, start_agent_id, end_agent_id,
            start_time, end_time, start_done, end_done,
            DATE(start_at) AS start_date, DATE(end_at, '-1 day') AS end_date
     FROM listing_attendees
     -- quantity > 0 excludes no-quantity sentinel lines from run sheets. The
     -- whole start/end OR is parenthesised so the predicate applies to BOTH arms
     -- (AND binds tighter than OR — a bare trailing AND would gate the end arm
     -- only, leaving ghost drop-offs on start-leg run sheets).
     WHERE ((start_agent_id IN (${agentPlaceholders}) AND DATE(start_at) IN (${datePlaceholders}))
        OR (end_agent_id IN (${agentPlaceholders}) AND DATE(end_at, '-1 day') IN (${datePlaceholders})))
        AND quantity > 0`,
    [...agentIds, ...dates, ...agentIds, ...dates],
  );
  const agentSet = new Set(agentIds);
  const dateSet = new Set(dates);
  // Each booking row can yield a drop-off leg, a collection leg, or both.
  return flatMap((row: RunSheetRow) =>
    compact([
      buildLeg(row, "start", agentSet, dateSet),
      buildLeg(row, "end", agentSet, dateSet),
    ]),
  )(rows);
};

/**
 * Mark a booking leg done/undone, but only when the leg's logistics agent is
 * one of `agentIds` — this enforces that an agent user can only update their
 * own runs. Returns true when a row was updated (i.e. the agent owns the leg).
 */
export const setLegDone = async (
  attendeeId: number,
  listingId: number,
  kind: DeliveryLegKind,
  done: boolean,
  agentIds: number[],
): Promise<boolean> => {
  if (agentIds.length === 0) return false;
  const doneColumn = kind === "start" ? "start_done" : "end_done";
  const agentColumn = kind === "start" ? "start_agent_id" : "end_agent_id";
  const result = await execute(
    // quantity > 0: refuse to complete a leg on a no-quantity line, so a stale or
    // crafted delivery form can't mark a hidden ghost's drop-off/collection done.
    `UPDATE listing_attendees SET ${doneColumn} = ?
          WHERE attendee_id = ? AND listing_id = ?
            AND ${agentColumn} IN (${inPlaceholders(agentIds)})
            AND quantity > 0`,
    [done ? 1 : 0, attendeeId, listingId, ...agentIds],
  );
  return result.rowsAffected > 0;
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
