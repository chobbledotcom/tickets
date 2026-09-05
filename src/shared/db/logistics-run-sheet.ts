/**
 * Run-sheet access: which booking legs an agent owns on a given day, and the
 * row-identity filter the agent check-in uses to keep only those rows in view.
 *
 * Kept apart from `logistics.ts`, which reads and writes assignments — see
 * "Modularised" in AGENTS.md.
 */

import { bookingSlotKey } from "#db/attendees/booking-slot.ts";
import { execute, inPlaceholders, queryAll } from "#db/client.ts";
import {
  type AssignmentRow,
  bookingAssignmentKey,
  type DeliveryBookingRef,
  mapBookingRows,
} from "#db/logistics.ts";
import {
  numberedStatement,
  type SqlParameter,
} from "#db/numbered-statement.ts";
import { columnFrom } from "#db/query.ts";
import { compact, flatMap, uniqueBy } from "#fp";

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

/** The alias every run-sheet read walks `listing_attendees` rows under. */
const SOURCE = "listingAttendee";

const runSheetLegWhere = (agentSlots: string, dateSlots: string): string => {
  const column = columnFrom(SOURCE);
  return `((${column("start_agent_id")} IN (${agentSlots}) AND DATE(${column("start_at")}) IN (${dateSlots}))
        OR (${column("end_agent_id")} IN (${agentSlots}) AND DATE(${column("end_at")}, '-1 day') IN (${dateSlots})))
        AND ${column("quantity")} > 0`;
};

/** Runs a run-sheet read for the given agents and dates: both id lists bind
 *  once, and the writer receives the slot lists its SQL reads wherever it
 *  needs them again. Callers must return early on empty id lists. */
const queryRunSheetLegs = async <Row>(
  agentIds: number[],
  dates: string[],
  write: (
    slots: { agentSlots: string; dateSlots: string },
    bind: SqlParameter,
  ) => string,
): Promise<Row[]> => {
  const { sql, args } = numberedStatement((bind) =>
    write(
      {
        agentSlots: agentIds.map(bind).join(", "),
        dateSlots: dates.map(bind).join(", "),
      },
      bind,
    ),
  );
  return queryAll<Row>(sql, args);
};

/** The run-sheet rows' source: every listing_attendees row whose drop-off or
 *  collection leg one of the bound agents owns on one of the bound dates. */
const runSheetRowsWhere = (agentSlots: string, dateSlots: string): string =>
  `FROM listing_attendees AS ${SOURCE}
      WHERE ${runSheetLegWhere(agentSlots, dateSlots)}`;

/** Collapse the identical legs a multi-path booking yields (a listing booked
 *  * through a package beside its standalone or second-package row is several
 *  * `listing_attendees` rows) into ONE run-sheet entry: the agents, dates and
 *  * times are written per listing and {@link setLegDone} completes every path
 *  * row together, so the paths are one physical drop-off/collection. A
 *  * collapsed leg reads done only when EVERY path row is done — a path added
 *  * after the run was ticked resurfaces as outstanding. */
const collapseDuplicateLegs = (legs: AgentRunLeg[]): AgentRunLeg[] => {
  const byIdentity = new Map<string, AgentRunLeg>();
  for (const leg of legs) {
    const key = [
      leg.attendeeId,
      leg.listingId,
      leg.kind,
      leg.agentId,
      leg.date,
      leg.time,
    ].join("|");
    const seen = byIdentity.get(key);
    byIdentity.set(
      key,
      seen === undefined ? leg : { ...seen, done: seen.done && leg.done },
    );
  }
  return [...byIdentity.values()];
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
  const rows = await queryRunSheetLegs<RunSheetRow>(
    agentIds,
    dates,
    ({ agentSlots, dateSlots }) =>
      `SELECT attendee_id, listing_id, start_agent_id, end_agent_id,
            start_time, end_time, start_done, end_done,
            DATE(start_at) AS start_date, DATE(end_at, '-1 day') AS end_date
     ${runSheetRowsWhere(agentSlots, dateSlots)}`,
  );
  const agentSet = new Set(agentIds);
  const dateSet = new Set(dates);
  // Each booking row can yield a drop-off leg, a collection leg, or both.
  return collapseDuplicateLegs(
    flatMap((row: RunSheetRow) =>
      compact([
        buildLeg(row, "start", agentSet, dateSet),
        buildLeg(row, "end", agentSet, dateSet),
      ]),
    )(rows),
  );
};

const bookingRefKey = (booking: DeliveryBookingRef): string =>
  bookingAssignmentKey(booking.attendeeId, booking.listingId);

/** A booking row matched on an agent's run sheet, with its full slot identity
 * (attendee + listing + date + parent + package) populated from the database
 * row. Two `listing_attendees` rows can share `(attendee_id, listing_id)` when
 * one attendee books the same listing twice — on different dates or through
 * different package paths — so a matched-row reply carries the slot dimensions
 * the caller needs to tell those rows apart, never just the attendee/listing
 * pair. Callers test an entry's row identity against this with
 * {@link runSheetBookingKey}. */
export type RunSheetBooking = {
  attendeeId: number;
  listingId: number;
  /** `DATE(start_at)` of the matched row (YYYY-MM-DD). Null only when the
   * matched row has no `start_at` (a dateless, non-daily booking) — possible
   * only via the collection leg, since the drop-off leg needs a `start_at`
   * date. */
  date: string | null;
  parentListingId: number;
  packageGroupId: number;
};

/** Stable row-identity key for one booking row: `attendeeId` plus the booking
 * slot key. Two `listing_attendees` rows cannot share this key, because the
 * (listing_id, attendee_id, start_at, parent_listing_id, package_group_id)
 * unique index uniquely identifies a row — and that is exactly what this joins.
 * Used on both sides of the agent-check-in filter so an attendee's matched row
 * never blesses a different row that happens to share the (attendee, listing)
 * pair. */
export const runSheetBookingKey = (
  booking: Readonly<
    Pick<
      RunSheetBooking,
      "attendeeId" | "listingId" | "date" | "parentListingId" | "packageGroupId"
    >
  >,
): string =>
  `${booking.attendeeId}|${bookingSlotKey(
    booking.listingId,
    booking.date,
    booking.parentListingId,
    booking.packageGroupId,
  )}`;

/** The matched booking rows the agent may view: each row's full slot identity,
 * drawn from `listing_attendees` rows that have a drop-off or collection leg
 * owned by one of `agentIds` on one of `dates`. Callers filter their richer
 * rows (e.g. token entries) by testing each row's {@link runSheetBookingKey}
 * against the set built from these, so a multi-row attendee exposes only the
 * row whose leg the agent actually owns. */
export const getAgentRunSheetBookings = async (
  agentIds: number[],
  dates: string[],
  bookings: DeliveryBookingRef[],
): Promise<RunSheetBooking[]> => {
  if (agentIds.length === 0) return [];
  if (dates.length === 0) return [];
  if (bookings.length === 0) return [];

  const uniqueBookings = uniqueBy(bookingRefKey)(bookings);
  // The agent and date lists bind first; the VALUES pairs bind through the
  // same binder, so no list is bound twice.
  const rows = await queryRunSheetLegs<{
    attendee_id: number;
    date: string | null;
    listing_id: number;
    parent_listing_id: number;
    package_group_id: number;
  }>(agentIds, dates, ({ agentSlots, dateSlots }, bind) => {
    const bookingPairs = uniqueBookings
      .map(
        (booking) =>
          `(${bind(booking.attendeeId)}, ${bind(booking.listingId)})`,
      )
      .join(", ");
    return `WITH requested_booking(attendee_id, listing_id) AS (
       VALUES ${bookingPairs}
     )
     SELECT DISTINCT ${SOURCE}.attendee_id,
                      ${SOURCE}.listing_id,
                      DATE(${SOURCE}.start_at) AS date,
                      ${SOURCE}.parent_listing_id,
                      ${SOURCE}.package_group_id
     FROM listing_attendees AS ${SOURCE}
     JOIN requested_booking AS requestedBooking
       ON requestedBooking.attendee_id = ${SOURCE}.attendee_id
      AND requestedBooking.listing_id = ${SOURCE}.listing_id
     WHERE ${runSheetLegWhere(agentSlots, dateSlots)}`;
  });
  return mapBookingRows(rows, (row) => ({
    date: row.date,
    packageGroupId: row.package_group_id,
    parentListingId: row.parent_listing_id,
  }));
};

/**
 * The distinct calendar dates on which the given logistics agents have any
 * run-sheet leg: every drop-off date (`start_at`) and every collection date
 * (`end_at - 1 day`, the last booked day — see {@link getAgentRunSheet}). These
 * are the days a staff member can open on the run sheet's date picker. Empty
 * input yields no query.
 */
export const getAgentRunSheetDates = async (
  agentIds: number[],
): Promise<string[]> => {
  if (agentIds.length === 0) return [];
  // Both UNION arms read the same agents, so the list is bound once.
  const { sql, args } = numberedStatement((bind) => {
    const agentSlots = agentIds.map(bind).join(", ");
    // quantity > 0 mirrors the run-sheet query: a no-quantity sentinel line is
    // never an operational delivery, so it must not offer a date to open.
    return `SELECT DATE(start_at) AS date FROM listing_attendees
        WHERE start_agent_id IN (${agentSlots})
          AND start_at IS NOT NULL AND quantity > 0
      UNION
      SELECT DATE(end_at, '-1 day') AS date FROM listing_attendees
        WHERE end_agent_id IN (${agentSlots})
          AND end_at IS NOT NULL AND quantity > 0`;
  });
  const rows = await queryAll<{ date: string }>(sql, args);
  return rows.map((row) => row.date).sort((a, b) => a.localeCompare(b));
};

/**
 * Mark a booking leg done/undone, but only when the leg's logistics agent is
 * one of `agentIds` — this enforces that an agent user can only update their
 * own runs — and only the row whose leg falls on `date`, so a mark is scoped to
 * the run-sheet day it was shown on. Returns true when a row was updated (i.e.
 * the agent owns the leg on that date).
 */
export const setLegDone = async (
  attendeeId: number,
  listingId: number,
  kind: DeliveryLegKind,
  date: string,
  done: boolean,
  agentIds: number[],
): Promise<boolean> => {
  if (agentIds.length === 0) return false;
  const doneColumn = kind === "start" ? "start_done" : "end_done";
  const agentColumn = kind === "start" ? "start_agent_id" : "end_agent_id";
  const dateExpression =
    kind === "start" ? "DATE(start_at)" : "DATE(end_at, '-1 day')";
  const result = await execute(
    // The date predicate scopes the update to the leg on the claimed run-sheet
    // day: a listing+attendee can have several rows across dates, so without it
    // a mark would flip legs on days the user isn't viewing.
    // quantity > 0: refuse to complete a leg on a no-quantity line, so a stale or
    // crafted delivery form can't mark a hidden ghost's drop-off/collection done.
    `UPDATE listing_attendees SET ${doneColumn} = ?
          WHERE attendee_id = ? AND listing_id = ?
            AND ${dateExpression} = ?
            AND ${agentColumn} IN (${inPlaceholders(agentIds)})
            AND quantity > 0`,
    [done ? 1 : 0, attendeeId, listingId, date, ...agentIds],
  );
  return result.rowsAffected > 0;
};
