/**
 * Atomic attendee creation across one or more event bookings.
 */

import type { InValue } from "@libsql/client";
import type {
  AttendeeInput,
  BuildAttendeeInput,
  CreateAttendeeResult,
  EncryptedAttendeeData,
} from "#lib/db/attendee-types.ts";
import { buildCapacityCheckedInsert } from "#lib/db/attendees/capacity.ts";
import { contactFields, encryptAttendeeFields } from "#lib/db/attendees/pii.ts";
import { executeBatchWithResults, insert } from "#lib/db/client.ts";
import { invalidateEventsCache } from "#lib/db/events.ts";
import type { Attendee } from "#lib/types.ts";

/** Build an INSERT statement for the attendees table from encrypted fields. */
export const buildAttendeeInsert = (enc: EncryptedAttendeeData) =>
  insert("attendees", {
    created: enc.created,
    pii_blob: enc.encryptedPiiBlob,
    ticket_token_index: enc.ticketTokenIndex,
  });

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  event_id: input.eventId,
  id: Number(input.insertId),
  ...contactFields(input),
  attachment_downloads: 0,
  checked_in: false,
  created: input.created,
  date: input.date,
  payment_id: input.paymentId,
  pii_blob: "",
  price_paid: String(input.pricePaid),
  quantity: input.quantity,
  refunded: false,
  ticket_token: input.ticketToken,
  ticket_token_index: input.ticketTokenIndex,
});

/**
 * Atomically create an attendee linked to one or more events.
 * Single ACID batch transaction:
 *   1. INSERT attendee (unconditional)
 *   2..N+1. For each booking: INSERT event_attendees with capacity check
 *   N+2. Clean up attendee if ALL capacity checks failed
 * Returns one Attendee per successful booking.
 */
export const createAttendeeAtomicImpl = async (
  input: AttendeeInput,
): Promise<CreateAttendeeResult> => {
  const {
    name,
    email,
    paymentId = "",
    phone = "",
    address = "",
    special_instructions = "",
    bookings,
  } = input;
  if (bookings.length === 0) {
    return { reason: "capacity_exceeded", success: false };
  }
  // Reject negative quantities outright — the atomic insert would happily
  // store a negative row and skew future capacity sums.
  if (bookings.some((b) => (b.quantity ?? 1) < 0)) {
    return { reason: "capacity_exceeded", success: false };
  }
  // Reject duplicate (event_id, date) pairs in a single cart. The
  // event_attendees unique index is on (event_id, attendee_id, start_at),
  // so two rows with the same tuple would violate it — silently dropping
  // one insert and delivering a half-fulfilled booking.
  const seenKeys = new Set<string>();
  for (const b of bookings) {
    const key = `${b.eventId}|${b.date ?? ""}`;
    if (seenKeys.has(key)) {
      return { reason: "capacity_exceeded", success: false };
    }
    seenKeys.add(key);
  }

  const contactInfo = { address, email, name, phone, special_instructions };
  // Use first booking's pricePaid for encryption (PII blob is shared)
  const enc = await encryptAttendeeFields({
    ...contactInfo,
    paymentId,
    pricePaid: bookings[0]!.pricePaid ?? 0,
  });
  if (!enc) {
    return { reason: "encryption_error", success: false };
  }

  // Use a subquery to look up the attendee ID instead of last_insert_rowid().
  // last_insert_rowid() updates after each INSERT in a batch, so the 2nd+
  // booking would get the event_attendees row ID instead of the attendee ID.
  const attendeeIdExpr =
    "(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)";
  const bookingStatements = bookings.map((booking) => {
    const insert = buildCapacityCheckedInsert(booking, attendeeIdExpr);
    // Splice ticketTokenIndex after the first arg (eventId) to bind
    // the ? in the attendeeIdExpr subquery
    const combined: InValue[] = [
      insert.args[0]!,
      enc.ticketTokenIndex,
      ...insert.args.slice(1),
    ];
    return { args: combined, sql: insert.sql };
  });

  // Single ACID transaction: attendee first, then capacity-checked event links.
  // If all capacity checks fail, the attendee is cleaned up in the final step.
  const batchResults = await executeBatchWithResults([
    // Step 1: Create attendee record (unconditional)
    buildAttendeeInsert(enc),
    // Steps 2..N+1: One capacity-checked INSERT per booking
    ...bookingStatements,
    // Final step: Clean up attendee if no event links were created
    {
      args: [enc.ticketTokenIndex, enc.ticketTokenIndex],
      sql: `DELETE FROM attendees WHERE id = (
              SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
            ) AND NOT EXISTS (
              SELECT 1 FROM event_attendees WHERE attendee_id = (
                SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
              )
            )`,
    },
  ]);

  // Check which bookings succeeded (steps 2..N+1 in batchResults, offset by 1)
  const successfulBookings: Attendee[] = [];
  for (let i = 0; i < bookings.length; i++) {
    if (batchResults[i + 1]!.rowsAffected > 0) {
      const booking = bookings[i]!;
      successfulBookings.push(
        buildAttendeeResult({
          eventId: booking.eventId,
          insertId: batchResults[0]!.lastInsertRowid,
          ...contactInfo,
          created: enc.created,
          date: booking.date ?? null,
          paymentId,
          pricePaid: booking.pricePaid ?? 0,
          quantity: booking.quantity ?? 1,
          ticketToken: enc.ticketToken,
          ticketTokenIndex: enc.ticketTokenIndex,
        }),
      );
    }
  }

  if (successfulBookings.length === 0) {
    return { reason: "capacity_exceeded", success: false };
  }

  invalidateEventsCache();
  return { attendees: successfulBookings, success: true };
};
