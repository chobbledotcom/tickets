/**
 * Atomic attendee update — apply a desired set of listing-registration lines
 * to an existing attendee, all-or-nothing.
 *
 * Computes the diff between the attendee's current `listing_attendees` rows
 * and the desired final state, then applies the writes as one ACID batch:
 *
 *   1. UPDATE attendees (PII)              — unconditional
 *   2. DELETE removed listing_attendees    — one per removed line
 *   3. UPDATE existing listing_attendees   — capacity-checked per line
 *   4. INSERT new listing_attendees        — capacity-checked per line
 *
 * Capacity is enforced twice. A read-only preflight (`allLinesFit`) rejects an
 * over-capacity edit before any write, which handles the common case and
 * keeps the failure cheap. The write batch then pairs every capacity-checked
 * statement with `CAPACITY_GUARD`: if a concurrent booking consumes the
 * capacity between the preflight and the commit, the guard trips a constraint
 * violation that aborts and rolls back the *whole* batch — so the unconditional
 * PII update and DELETEs can never commit while a line silently fails. A plain
 * `batch()` is required (not an interactive transaction, which the edge runtime
 * does not support reliably), and a zero-row capacity statement is not itself
 * an error, which is exactly why the guard is needed.
 *
 * The attendee is never left without at least one listing link — a guard
 * clause rejects "remove every line" up front so the DELETE step never
 * strips the attendee down to an orphan row.
 */

import type { InValue } from "@libsql/client";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
  UpdateAttendeePIIInput,
} from "#shared/db/attendee-types.ts";
import { hasDuplicateBookingSlot } from "#shared/db/attendees/booking-slot.ts";
import {
  buildCapacityCheckedInsert,
  checkLinesCapacity,
  dateToStartEnd,
} from "#shared/db/attendees/capacity.ts";
import { LISTING_ATTENDEE_ROW_COLS } from "#shared/db/attendees/queries.ts";
import { buildCapacityCondition } from "#shared/db/capacity.ts";
import { executeBatchWithResults, queryAll } from "#shared/db/client.ts";

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
const CAPACITY_GUARD = {
  args: [] as [],
  sql: `INSERT INTO listing_attendees (listing_id, attendee_id, quantity)
        SELECT NULL, NULL, 1 WHERE changes() = 0`,
};

/** A desired final-state line for the atomic update path. Re-exported from
 * the shared types module so callers can keep importing it from here. */
export type AtomicDesiredLine = DesiredListingLine;

/**
 * Extra SET columns when a line is saved as the no-quantity sentinel (quantity
 * 0): clear any check-in state and the logistics assignment — agents, times, and
 * the start_done/end_done completion flags — in the same write. A quantity-0
 * line is hidden from the roster's check-in reads and from run sheets, so a
 * lingering checked_in or a completed leg would otherwise haunt those surfaces;
 * resetting the done flags too stops a completed leg reappearing as done if the
 * line is later re-activated. Real lines (quantity ≥ 1) keep their state. The
 * fragment carries no bind args, so it slots into both update branches.
 */
const noQuantityResetColumns = (quantity: number): string =>
  quantity === 0
    ? ", checked_in = 0, start_agent_id = NULL, end_agent_id = NULL," +
      " start_time = '', end_time = '', start_done = 0, end_done = 0"
    : "";

/** Build the self-excluding capacity condition for one desired line. */
const lineCapacityCondition = (line: AtomicDesiredLine, attendeeId: number) =>
  buildCapacityCondition(
    line.listingId,
    line.quantity,
    line.date,
    attendeeId,
    line.durationDays,
  );

/** The booking shape `checkLineCapacity` and `buildCapacityCheckedInsert`
 * expect, projected from a desired line. */
const lineBooking = (line: AtomicDesiredLine) => ({
  date: line.date,
  durationDays: line.durationDays,
  listingId: line.listingId,
  quantity: line.quantity,
});

/** Result of an atomic attendee update. */
export type UpdateAttendeeAtomicResult =
  | { success: true }
  | { success: false; reason: "capacity_exceeded" }
  | { success: false; reason: "no_lines" };

/** A pre-fetched existing booking row plus its line key. */
export type ExistingLine = {
  key: string;
  booking: ListingAttendeeRow;
};

/** Read all current listing_attendees rows for an attendee, with line keys. */
export const loadExistingLines = async (
  attendeeId: number,
): Promise<ExistingLine[]> => {
  const rows = await queryAll<ListingAttendeeRow>(
    `SELECT ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees WHERE attendee_id = ?
     ORDER BY start_at, listing_id`,
    [attendeeId],
  );
  return rows.map((booking) => ({
    booking,
    key: lineKeyFromBooking(booking),
  }));
};

/** Build the canonical line key from a stored booking row (matches the
 * `${listingId}|${startAt}|${parentListingId}` identity carried by the
 * form's hidden key field). Including parent_listing_id distinguishes the two
 * rows produced when the same child is booked under two different parents. */
export const lineKeyFromBooking = (booking: ListingAttendeeRow): string =>
  `${booking.listing_id}|${booking.start_at ?? ""}|${booking.parent_listing_id}`;

/**
 * Read-only preflight: returns true when every desired line fits, using the
 * same self-excluding capacity expression the write guards use. Each line's
 * check is independent (lines target distinct listing/date slots and exclude
 * the attendee's own rows), so a true result means the whole edit can be
 * applied. The per-line `CAPACITY_GUARD` in the write batch still closes the
 * narrow window between this check and the commit.
 */
const allLinesFit = async (
  attendeeId: number,
  desired: AtomicDesiredLine[],
): Promise<boolean> => {
  const fits = await checkLinesCapacity(desired.map(lineBooking), attendeeId);
  return fits.every((ok) => ok);
};

/**
 * Apply a desired final-state line set to an existing attendee atomically.
 *
 * - `attendeeId` — the attendee being edited.
 * - `encryptedPiiBlob` — already-encrypted PII blob to write into the
 *   attendees row. The caller encrypts so this function stays IO focused.
 * - `desired` — the desired final-state line set.
 */
export const applyAttendeeAtomicEdit = async (
  attendeeId: number,
  encryptedPiiBlob: string,
  desired: AtomicDesiredLine[],
  allowOverbook = false,
): Promise<UpdateAttendeeAtomicResult> => {
  if (desired.length === 0) {
    return { reason: "no_lines", success: false };
  }

  // Reject duplicate (listingId, date, parentListingId) pairs up front — two
  // desired lines on the same slot would collide on the unique index.
  if (hasDuplicateBookingSlot(desired)) {
    return { reason: "capacity_exceeded", success: false };
  }

  // Preflight: reject (without writing anything) when any line can't fit. The
  // common over-capacity case never touches the DB; the per-line CAPACITY_GUARD
  // in the batch below still rolls the whole edit back if a concurrent booking
  // wins the race between this check and the commit. Skipped entirely when the
  // caller has opted into overbooking (admin manual edit).
  if (!allowOverbook && !(await allLinesFit(attendeeId, desired))) {
    return { reason: "capacity_exceeded", success: false };
  }

  const existing = await loadExistingLines(attendeeId);
  const existingByKey = new Map(existing.map((e) => [e.key, e.booking]));

  // Diff: removed / updated / new
  const desiredKeys = new Set(desired.map((line) => line.key));
  const removed: ExistingLine[] = existing.filter(
    (row) => !desiredKeys.has(row.key),
  );
  const updates: AtomicDesiredLine[] = desired.filter((line) => line.exists);
  const inserts: AtomicDesiredLine[] = desired.filter((line) => !line.exists);

  // Build one batch that runs as a single ACID transaction. Each
  // capacity-checked write is immediately followed by CAPACITY_GUARD, which
  // aborts (and rolls back) the whole batch if that write affected no rows.
  const statements: Array<{ args: InValue[]; sql: string }> = [];

  // Step 1: Update PII (unconditional).
  statements.push({
    args: [encryptedPiiBlob, attendeeId],
    sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
  });

  // Step 2: Delete removed lines (identified by listing_id + start_at + parent_listing_id).
  for (const { booking } of removed) {
    statements.push({
      args: [
        attendeeId,
        booking.listing_id,
        booking.start_at ?? null,
        booking.parent_listing_id,
      ],
      sql: `DELETE FROM listing_attendees
            WHERE attendee_id = ? AND listing_id = ? AND start_at IS ? AND parent_listing_id = ?`,
    });
  }

  // Step 3: Update existing lines. The WHERE pins the row by its *old* start_at
  // and parent_listing_id so an attendee holding two rows for the same daily
  // listing on different dates (or under different parents) updates only the
  // target row. Capacity-checked + guarded unless the caller opted into
  // overbooking, in which case the update is unconditional.
  for (const line of updates) {
    const existingRow = existingByKey.get(line.key);
    const oldStartAt = existingRow?.start_at ?? null;
    const oldParentListingId = existingRow?.parent_listing_id ?? 0;
    const { startAt, endAt } = dateToStartEnd(line.date, line.durationDays);
    const pin = [attendeeId, line.listingId, oldStartAt, oldParentListingId];
    const setClause = `UPDATE listing_attendees SET quantity = ?, start_at = ?, end_at = ?${noQuantityResetColumns(line.quantity)}
            WHERE attendee_id = ? AND listing_id = ? AND start_at IS ? AND parent_listing_id = ?`;
    if (allowOverbook) {
      statements.push({
        args: [line.quantity, startAt, endAt, ...pin],
        sql: setClause,
      });
      continue;
    }
    const condition = lineCapacityCondition(line, attendeeId);
    statements.push({
      args: [line.quantity, startAt, endAt, ...pin, ...condition.args],
      sql: `${setClause}\n              AND ${condition.sql}`,
    });
    statements.push(CAPACITY_GUARD);
  }

  // Step 4: Insert new lines (capacity-checked + guarded unless overbooking).
  for (const line of inserts) {
    statements.push(
      buildCapacityCheckedInsert(
        lineBooking(line),
        "?",
        attendeeId,
        allowOverbook,
      ),
    );
    if (!allowOverbook) statements.push(CAPACITY_GUARD);
  }

  // The batch runs as one ACID transaction. After the preflight above this
  // only fails if a concurrent booking consumed the capacity in the meantime —
  // a CAPACITY_GUARD then aborts and rolls the whole batch back, surfacing as a
  // thrown error (the caller retries), never a partial write.
  await executeBatchWithResults(statements);

  return { success: true };
};

/** Re-export so route handlers can build the input type without importing
 * the DB layer's internal module path. */
export type { UpdateAttendeePIIInput };
