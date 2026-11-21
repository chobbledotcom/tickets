/**
 * Capacity is enforced twice. The read-only preflight keeps the common failure
 * cheap. `CAPACITY_GUARD` on every capacity-checked statement then catches a
 * concurrent booking that took the capacity in between.
 *
 * The guard is needed because a zero-row capacity statement is not itself an
 * error. A plain batch is needed because the edge runtime has no reliable
 * interactive transactions.
 *
 * "Remove every line" is rejected up front, so the deletes can never leave the
 * attendee an orphan row.
 */

import type {
  DesiredListingLine,
  ListingAttendeeRow,
  UpdateAttendeePIIInput,
} from "#db/attendee-types.ts";
import { bookingRowDelete, inBookingSlot } from "#db/attendees/booking-rows.ts";
import { hasDuplicateBookingSlot } from "#db/attendees/booking-slot.ts";
import {
  buildCapacityCheckedInsert,
  unfitListingIds,
} from "#db/attendees/capacity/checks.ts";
import { dateToStartEnd } from "#db/attendees/capacity/range.ts";
import { attendeePiiWriteStatements } from "#db/attendees/pii-write.ts";
import { LISTING_ATTENDEE_ROW_COLS } from "#db/attendees/queries.ts";
import { capacityConditionFor } from "#db/capacity.ts";
import { executeBatchWithResults, queryAll } from "#db/client.ts";
import { abortUnless } from "#db/guarded-writes.ts";
import { among, valued, whereTail } from "#db/select/expression.ts";
import { tableNode } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { type Changes, update } from "#db/write.ts";
import { requiredMapValue, unique } from "#fp";
import {
  CANCELLABLE_STATUSES,
  isCancellable,
} from "#payment/subscription-machine-spec.ts";
import type { AttendeeUpdateFailureReason } from "#shared/attendee-failures.ts";

/**
 * A guard statement that aborts the whole write batch when the immediately
 * preceding capacity-checked write affected zero rows. `changes()` reports
 * the prior statement's row count; on zero, this tries to insert a NULL
 * listing_id, which violates the NOT NULL constraint and rolls the batch back.
 * When the prior write succeeded, `changes() > 0`, the WHERE matches nothing,
 * and the guard is a no-op. This is what makes the edit all-or-nothing on a
 * `batch()` — a zero-row capacity statement is not itself an error and would
 * otherwise commit alongside the unconditional PII/DELETE writes.
 */
export const CAPACITY_GUARD: SqlStatement = abortUnless(
  sql`listing_attendees (listing_id, attendee_id, quantity)`,
  sql`NULL, NULL, 1`,
)(sql`changes() != 0`);

/** A desired final-state line for the atomic update path — the shared
 * DesiredListingLine the listings types module exports. */

/**
 * Extra SET columns when a line is saved as the no-quantity sentinel (quantity
 * 0): clear the logistics assignment — agents, times, and the
 * start_done/end_done completion flags — in the same write. A quantity-0 line
 * is hidden from run sheets, so a completed leg would otherwise haunt them;
 * resetting the done flags too stops a completed leg reappearing as done if the
 * line is later re-activated. Real lines (quantity ≥ 1) keep their state.
 */
const noQuantityResetColumns = (
  quantity: number,
): Changes<"listing_attendees"> =>
  quantity === 0
    ? {
        endAgentId: null,
        endDone: 0,
        endTime: "",
        startAgentId: null,
        startDone: 0,
        startTime: "",
      }
    : {};

/** The booking shape `checkLineCapacity` and `buildCapacityCheckedInsert`
 * expect, projected from a desired line. */
const lineBooking = (line: DesiredListingLine) => ({
  date: line.date,
  durationDays: line.durationDays,
  listingId: line.listingId,
  packageGroupId: line.packageGroupId ?? 0,
  quantity: line.quantity,
});
const lineRange = (line: DesiredListingLine) =>
  dateToStartEnd(line.date, line.durationDays);

/** Result of an atomic attendee update. Every failure carries `listingIds` —
 *  the SPECIFIC listings that failed the capacity preflight — so a caller can
 *  tell the operator what was actually sold out instead of a bare reason
 *  string. Empty when no particular listing is to blame: a duplicate booking
 *  slot (see {@link applyAttendeeAtomicEdit}'s duplicate-slot guard) or a
 *  `no_lines` rejection. */
export type UpdateAttendeeAtomicResult =
  | { success: true }
  | {
      success: false;
      reason: AttendeeUpdateFailureReason;
      listingIds: number[];
    };

/** A pre-fetched existing booking row plus its line key. */
export type ExistingLine = {
  key: string;
  booking: ListingAttendeeRow;
};

/** The distinct listing ids an attendee's existing lines book, in line order. */
export const existingListingIds = (
  existing: readonly ExistingLine[],
): number[] => unique(existing.map((line) => line.booking.listing_id));

export type AttendeeEditWork = {
  before: SqlStatement[];
  after: SqlStatement[];
};
/** Read all current listing_attendees rows for an attendee, with line keys. */
export const loadExistingLines = async (
  attendeeId: number,
): Promise<ExistingLine[]> => {
  const rows = await queryAll<ListingAttendeeRow>(
    sql`SELECT ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees WHERE attendee_id = ${attendeeId}
     ORDER BY start_at, listing_id`,
  );
  return rows.map((booking) => ({
    booking,
    key: lineKeyFromBooking(booking),
  }));
};

/** Build the canonical line key from a stored booking row (matches the
 * `${listingId}|${startAt}|${parentListingId}|${packageGroupId}` identity
 * carried by the form's hidden key field). parent_listing_id distinguishes the
 * two rows produced when the same child is booked under two different parents;
 * package_group_id the rows produced when the same listing is booked through
 * two packages (or a package plus its own standalone row) in one order. */
export const lineKeyFromBooking = (booking: ListingAttendeeRow): string =>
  `${booking.listing_id}|${
    booking.start_at ?? ""
  }|${booking.parent_listing_id}|${booking.package_group_id}`;

/**
 * Read-only preflight: the listing ids among `desired` that do NOT fit, using
 * the same self-excluding capacity expression the write guards use. Each
 * line's check is independent (lines target distinct listing/date slots and
 * exclude the attendee's own rows), so an empty result means the whole edit
 * can be applied. The per-line `CAPACITY_GUARD` in the write batch still
 * closes the narrow window between this check and the commit.
 */
const unfitLineListingIds = (
  attendeeId: number,
  desired: DesiredListingLine[],
): Promise<number[]> => unfitListingIds(desired.map(lineBooking), attendeeId);

/** The preflight capacity rejection, or null when every *changed* line fits
 *  (unchanged no-op preserves are excluded — see {@link isUnchangedLine}) or
 *  overbooking skips the preflight entirely. Split out of {@link
 *  applyAttendeeAtomicEdit} to keep that function's branching flat. */
const preflightCapacityFailure = async (
  attendeeId: number,
  desired: DesiredListingLine[],
  existingByKey: Map<string, ListingAttendeeRow>,
  allowOverbook: boolean,
): Promise<{
  success: false;
  reason: "capacity_exceeded";
  listingIds: number[];
} | null> => {
  if (allowOverbook) return null;
  const changed = changedLinesForPreflight(desired, existingByKey);
  if (changed.length === 0) return null;
  const listingIds = await unfitLineListingIds(attendeeId, changed);
  return listingIds.length > 0
    ? { listingIds, reason: "capacity_exceeded", success: false }
    : null;
};

/** True when a desired line preserves an existing booking unchanged (same slot,
 *  date range, and quantity) — a no-op that adds no capacity, so the capacity
 *  guard's `active = 1` subquery must not strand it on a deactivated listing.
 *  A line that keeps the same key but moves its date or changes quantity IS
 *  changed and must be capacity-checked. */
export const isUnchangedLine = (
  line: DesiredListingLine,
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
): boolean => {
  const existing = existingByKey.get(line.key);
  if (!existing || existing.quantity !== line.quantity) return false;
  const { startAt, endAt } = lineRange(line);
  return existing.start_at === startAt && existing.end_at === endAt;
};

/** The lines whose capacity impact must be preflight-checked: new or
 *  quantity-changed lines, excluding unchanged preserves. */
const changedLinesForPreflight = (
  desired: DesiredListingLine[],
  existingByKey: Map<string, ListingAttendeeRow>,
): DesiredListingLine[] =>
  desired.filter((line) => !isUnchangedLine(line, existingByKey));

/** The existing row's start_at, parent_listing_id, and package_group_id for
 *  the UPDATE pin, so an attendee holding two rows for the same daily listing
 *  on different dates, under different parents, or through different packages
 *  updates only the target row. */
const oldPinOf = (
  line: DesiredListingLine,
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
): {
  startAt: string | null;
  parentListingId: number;
  packageGroupId: number;
} => {
  const row = requiredMapValue(existingByKey, line.key);
  return {
    packageGroupId: row.package_group_id,
    parentListingId: row.parent_listing_id,
    startAt: row.start_at,
  };
};

/** The UPDATE statement for one existing line. Unconditional (no capacity
 *  guard) when the caller opted into overbooking OR the line is an unchanged
 *  no-op preserve; capacity-checked + guarded otherwise. */
export const updateStatementFor = (
  line: DesiredListingLine,
  attendeeId: number,
  oldPin: {
    startAt: string | null;
    parentListingId: number;
    packageGroupId: number;
  },
  skipCapacityGuard: boolean,
): SqlStatement => {
  const { startAt, endAt } = lineRange(line);
  // A smaller quantity also lowers the admitted count, so it never exceeds it.
  const changes = update(tables.listing_attendees, (row) => ({
    checkedIn: valued<number>(sql`MIN(${row.checkedIn}, ${line.quantity})`),
    endAt,
    quantity: line.quantity,
    startAt,
    ...noQuantityResetColumns(line.quantity),
  }));
  const slot = inBookingSlot(attendeeId, {
    listing_id: line.listingId,
    package_group_id: oldPin.packageGroupId,
    parent_listing_id: oldPin.parentListingId,
    start_at: oldPin.startAt,
  });
  return changes.where((row) => [
    ...slot(row),
    skipCapacityGuard ? true : capacityConditionFor(line, attendeeId),
  ]);
};

/** One desired line's write statement, and whether the batch must follow it
 * with CAPACITY_GUARD: a capacity-checked write can affect zero rows, an
 * unconditional one cannot. */
export const lineStatementFor = (
  line: DesiredListingLine,
  attendeeId: number,
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
  allowOverbook: boolean,
): { guarded: boolean; statement: SqlStatement } => {
  if (!line.exists) {
    return {
      guarded: !allowOverbook,
      statement: buildCapacityCheckedInsert(
        lineBooking(line),
        attendeeId,
        allowOverbook,
      ),
    };
  }
  const skipGuard = allowOverbook || isUnchangedLine(line, existingByKey);
  return {
    guarded: !skipGuard,
    statement: updateStatementFor(
      line,
      attendeeId,
      oldPinOf(line, existingByKey),
      skipGuard,
    ),
  };
};

/** The stored rows the desired line set no longer names. */
const removedLines = (
  desired: readonly DesiredListingLine[],
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
): ListingAttendeeRow[] => {
  const desiredKeys = new Set(desired.map((line) => line.key));
  return [...existingByKey.values()].filter(
    (row) => !desiredKeys.has(lineKeyFromBooking(row)),
  );
};

/** A guard that aborts the batch while the booking row still has a running
 * subscription: its row with no listing breaks NOT NULL. It tests the current
 * plan, not changes(), so an absent ordinary row stays a no-op. */
const livePlanGuard = (
  attendeeId: number,
  booking: ListingAttendeeRow,
): SqlStatement => {
  const row = tableNode(tables.listing_attendees, "listingAttendee");
  return sql`INSERT INTO listing_attendees (listing_id, attendee_id, quantity)
    SELECT NULL, NULL, 1 FROM listing_attendees AS listingAttendee${whereTail([
      ...inBookingSlot(attendeeId, booking)(row),
      among(row.subscriptionStatus, CANCELLABLE_STATUSES),
    ])}`;
};

/** Each removed line has a live-plan guard before its delete. Capacity-checked
 * writes have CAPACITY_GUARD after them. The caller runs all statements as one
 * batch, so a refused write rolls the whole edit back. */
export const buildAttendeeEditBatch = (
  attendeeId: number,
  desired: readonly DesiredListingLine[],
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
  allowOverbook: boolean,
): SqlStatement[] => {
  const statements = removedLines(desired, existingByKey).flatMap(
    (booking): SqlStatement[] => [
      livePlanGuard(attendeeId, booking),
      bookingRowDelete(attendeeId, booking),
    ],
  );
  for (const line of [
    ...desired.filter((line) => line.exists),
    ...desired.filter((line) => !line.exists),
  ]) {
    const { guarded, statement } = lineStatementFor(
      line,
      attendeeId,
      existingByKey,
      allowOverbook,
    );
    statements.push(statement);
    if (guarded) statements.push(CAPACITY_GUARD);
  }
  return statements;
};

const EMPTY_EDIT_WORK: AttendeeEditWork = { after: [], before: [] };

/**
 * Apply a desired final-state line set to an existing attendee atomically.
 *
 * - `attendeeId` — the attendee being edited.
 * - `pii` — all PII facts, encrypted inside the same transaction.
 * - `desired` — the desired final-state line set.
 */
export const applyAttendeeAtomicEdit = async (
  attendeeId: number,
  pii: UpdateAttendeePIIInput,
  desired: DesiredListingLine[],
  allowOverbook = false,
  work: AttendeeEditWork = EMPTY_EDIT_WORK,
): Promise<UpdateAttendeeAtomicResult> => {
  if (desired.length === 0) {
    return { listingIds: [], reason: "no_lines", success: false };
  }

  // Reject duplicate (listingId, date, parentListingId) pairs up front — two
  // desired lines on the same slot would collide on the unique index. Not a
  // capacity shortfall, so no specific listing is named.
  if (hasDuplicateBookingSlot(desired)) {
    return { listingIds: [], reason: "capacity_exceeded", success: false };
  }

  const existing = await loadExistingLines(attendeeId);
  const existingByKey = new Map(existing.map((e) => [e.key, e.booking]));

  // A removed line loses its row, and a row with a running subscription must
  // stay until the owner cancels it.
  const lostPlans = removedLines(desired, existingByKey).filter((booking) =>
    isCancellable(booking.subscription_status),
  );
  if (lostPlans.length > 0) {
    return {
      listingIds: lostPlans.map((booking) => booking.listing_id),
      reason: "subscription_live",
      success: false,
    };
  }

  // Preflight: reject (without writing anything) when any changed line can't
  // fit, before any write happens.
  const preflightFailure = await preflightCapacityFailure(
    attendeeId,
    desired,
    existingByKey,
    allowOverbook,
  );
  if (preflightFailure) return preflightFailure;

  // Build one batch that runs as a single ACID transaction. Each
  // capacity-checked write is immediately followed by CAPACITY_GUARD, which
  // aborts (and rolls back) the whole batch if that write affected no rows.
  const statements: SqlStatement[] = [
    ...work.before,
    ...(await attendeePiiWriteStatements(attendeeId, pii)),
    ...buildAttendeeEditBatch(
      attendeeId,
      desired,
      existingByKey,
      allowOverbook,
    ),
    ...work.after,
  ];

  // A concurrent capacity change or live plan can refuse the batch after
  // preflight. Its guard throws a database error and rolls back every write.
  // A retry reads the current bookings and repeats the preflight.
  await executeBatchWithResults(statements);

  return { success: true };
};

/** Re-export so route handlers can build the input type without importing
 * the DB layer's internal module path. */
export type { UpdateAttendeePIIInput };
