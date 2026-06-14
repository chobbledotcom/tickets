/**
 * Atomic attendee update — apply a desired set of event-registration lines
 * to an existing attendee in a single database transaction.
 *
 * Computes the diff between the attendee's current `event_attendees` rows
 * and the desired final state, then runs the writes as one ACID batch:
 *
 *   1. UPDATE attendees (PII)            — unconditional
 *   2. DELETE removed event_attendees    — one per removed line
 *   3. UPDATE existing event_attendees   — capacity-checked per line
 *   4. INSERT new event_attendees        — capacity-checked per line
 *
 * Capacity-checked statements use `buildCapacityCondition` (self-excluding
 * the attendee) so the SQL itself rejects over-capacity writes. After the
 * batch returns, we inspect `rowsAffected` on each capacity-checked
 * statement. If any returned 0, the line lost a race against a concurrent
 * booking — the operator is sent back to the form to retry, with the
 * failing line named in the error.
 *
 * The attendee is never left without at least one event link — a guard
 * clause rejects "remove every line" up front so the DELETE step never
 * strips the attendee down to an orphan row.
 */

import type { InValue } from "@libsql/client";
import type {
  EventAttendeeRow,
  UpdateAttendeePIIInput,
} from "#shared/db/attendee-types.ts";
import {
  buildCapacityCheckedInsert,
  dateToStartEnd,
} from "#shared/db/attendees/capacity.ts";
import { buildCapacityCondition } from "#shared/db/capacity.ts";
import { executeBatchWithResults, queryAll } from "#shared/db/client.ts";
import { invalidateEventsCache } from "#shared/db/events.ts";/** A desired final-state line for the atomic update path. Mirrors the
 * `DesiredLine` exported from `attendee-form-model.ts` but defined here
 * too so the DB layer doesn't import from the routes layer. */
export type AtomicDesiredLine = {
  /** Stable identity from the existing row (`${eventId}|${startAt}`). Empty
   * string for newly-added lines. */
  key: string;
  eventId: number;
  quantity: number;
  /** YYYY-MM-DD for daily events, null otherwise. */
  date: string | null;
  /** Duration (days) — only meaningful for daily events. Defaults to 1. */
  durationDays: number;
  /** True when the line carries an existing event_attendees identity. */
  exists: boolean;
};

/** Result of an atomic attendee update. */
export type UpdateAttendeeAtomicResult =
  | { success: true }
  | {
      success: false;
      reason: "capacity_exceeded";
      /** Line key that lost the capacity race, when identifiable. */
      failingKey: string | null;
    }
  | { success: false; reason: "encryption_error" }
  | { success: false; reason: "no_lines" };

/** A pre-fetched existing booking row plus its line key. */
export type ExistingLine = {
  key: string;
  booking: EventAttendeeRow;
};

/** Read all current event_attendees rows for an attendee, with line keys. */
export const loadExistingLines = async (
  attendeeId: number,
): Promise<ExistingLine[]> => {
  const rows = await queryAll<EventAttendeeRow>(
    `SELECT event_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM event_attendees WHERE attendee_id = ?
     ORDER BY start_at, event_id`,
    [attendeeId],
  );
  return rows.map((booking) => ({
    booking,
    key: lineKeyFromBooking(booking),
  }));
};

/** Build the canonical line key from a stored booking row. */
export const lineKeyFromBooking = (booking: EventAttendeeRow): string =>
  `${booking.event_id}|${booking.start_at ?? ""}`;

/**
 * Apply a desired final-state line set to an existing attendee atomically.
 *
 * - `attendeeId` — the attendee being edited.
 * - `piiInput` — full PII block (rebuilt/encrypted by the caller via
 *   `updateAttendeePII` if you only need PII; this function does the full
 *   multi-line update).
 * - `encryptedPiiBlob` — already-encrypted PII blob to write into the
 *   attendees row. The caller encrypts so this function stays sync/IO
 *   focused.
 * - `desired` — the desired final-state line set.
 */
export const updateAttendeeAtomic = async (
  attendeeId: number,
  encryptedPiiBlob: string,
  desired: AtomicDesiredLine[],
): Promise<UpdateAttendeeAtomicResult> => {
  if (desired.length === 0) {
    return { reason: "no_lines", success: false };
  }

  // Reject duplicate (eventId, date) pairs up front — the unique index on
  // event_attendees (event_id, attendee_id, start_at) would silently drop
  // one of the conflicting writes otherwise.
  const seenKeys = new Set<string>();
  for (const line of desired) {
    const dedupeKey = `${line.eventId}|${line.date ?? ""}`;
    if (seenKeys.has(dedupeKey)) {
      return { failingKey: line.key, reason: "capacity_exceeded", success: false };
    }
    seenKeys.add(dedupeKey);
  }

  const existing = await loadExistingLines(attendeeId);

  // Diff: removed / updated / new
  const desiredKeys = new Set(desired.map((line) => line.key));
  const removed: ExistingLine[] = existing.filter(
    (row) => !desiredKeys.has(row.key),
  );
  const updates: AtomicDesiredLine[] = desired.filter((line) => line.exists);
  const inserts: AtomicDesiredLine[] = desired.filter((line) => !line.exists);

  // Build the batch — every statement runs in one ACID transaction.
  const statements: Array<{ args: InValue[]; sql: string }> = [];

  // Step 1: Update PII (unconditional)
  statements.push({
    args: [encryptedPiiBlob, attendeeId],
    sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
  });

  // Step 2: Delete removed lines (each identified by event_id + start_at,
  // which together with attendee_id form the unique index).
  for (const { booking } of removed) {
    statements.push({
      args: [attendeeId, booking.event_id, booking.start_at ?? null],
      sql: `DELETE FROM event_attendees
            WHERE attendee_id = ? AND event_id = ? AND start_at IS ?`,
    });
  }

  // Step 3: Update existing lines (capacity-checked, self-excluding).
  const updateResults: Array<{ line: AtomicDesiredLine; stmtIndex: number }> = [];
  for (const line of updates) {
    const { startAt, endAt } = dateToStartEnd(line.date, line.durationDays);
    const condition = buildCapacityCondition(
      line.eventId,
      line.quantity,
      line.date,
      attendeeId,
      line.durationDays,
    );
    statements.push({
      args: [
        line.quantity,
        startAt,
        endAt,
        attendeeId,
        line.eventId,
        ...condition.args,
      ],
      sql: `UPDATE event_attendees SET quantity = ?, start_at = ?, end_at = ?
            WHERE attendee_id = ? AND event_id = ? AND ${condition.sql}`,
    });
    updateResults.push({ line, stmtIndex: statements.length - 1 });
  }

  // Step 4: Insert new lines (capacity-checked, self-excluding).
  const insertResults: Array<{ line: AtomicDesiredLine; stmtIndex: number }> = [];
  for (const line of inserts) {
    const stmt = buildCapacityCheckedInsert(
      {
        date: line.date,
        durationDays: line.durationDays,
        eventId: line.eventId,
        quantity: line.quantity,
      },
      "?",
      attendeeId,
    );
    statements.push(stmt);
    insertResults.push({ line, stmtIndex: statements.length - 1 });
  }

  const batchResults = await executeBatchWithResults(statements);

  // Capacity-checked statements that affected 0 rows lost a race against a
  // concurrent booking. The transaction still committed, but the failing
  // line is now missing — surface that to the operator so they can retry.
  for (const { line, stmtIndex } of [...updateResults, ...insertResults]) {
    if (batchResults[stmtIndex]!.rowsAffected === 0) {
      invalidateEventsCache();
      return {
        failingKey: line.key,
        reason: "capacity_exceeded",
        success: false,
      };
    }
  }

  invalidateEventsCache();
  return { success: true };
};

/** Convenience entry point — kept as a separate export so route handlers
 * can mock the atomic update during tests without reaching into the
 * internal implementation. */
export const applyAttendeeAtomicEdit = (
  attendeeId: number,
  encryptedPiiBlob: string,
  desired: AtomicDesiredLine[],
): Promise<UpdateAttendeeAtomicResult> =>
  updateAttendeeAtomic(attendeeId, encryptedPiiBlob, desired);

/** Re-export so route handlers can build the input type without importing
 * the DB layer's internal module path. */
export type { UpdateAttendeePIIInput };
