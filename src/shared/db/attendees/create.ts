/**
 * Atomic attendee creation across one or more listing bookings.
 */

import type { InValue } from "@libsql/client";
import { addDays } from "#shared/dates.ts";
import type {
  AttendeeInput,
  BuildAttendeeInput,
  CreateAttendeeResult,
  EncryptedAttendeeData,
} from "#shared/db/attendee-types.ts";
import { hasDuplicateBookingSlot } from "#shared/db/attendees/booking-slot.ts";
import { buildCapacityCheckedInsert } from "#shared/db/attendees/capacity.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import {
  contactFields,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import { executeBatchWithResults, insert } from "#shared/db/client.ts";
import {
  type BookingSource,
  hashEmail,
  hashPhone,
  recordBooking,
  recordVisit,
  unrecordBooking,
  unrecordVisit,
} from "#shared/db/contact-preferences.ts";
import { bestEffort } from "#shared/logger.ts";
import { type Attendee, normalizeDurationDays } from "#shared/types.ts";

/**
 * Enforce all-or-nothing semantics on a (greedy) create result.
 *
 * `createAttendeeAtomic` fulfils bookings greedily: it returns success as
 * long as at least one booking was created. Callers that need every
 * requested line to succeed pass the expected count here; if the result is
 * short, the partially-created attendee is rolled back and a failure reason
 * is returned. Shared by the public checkout flow, the webhook flow, and the
 * admin manual-add form so the "no half-saved attendee" rule lives in one
 * place.
 */
export const ensureAllBookings = async (
  result: CreateAttendeeResult,
  expectedCount: number,
  source: BookingSource,
): Promise<
  { ok: true } | { ok: false; reason: "capacity_exceeded" | "encryption_error" }
> => {
  if (result.success && result.attendees.length >= expectedCount) {
    return { ok: true };
  }
  if (result.success && result.attendees.length > 0) {
    const attendee = result.attendees[0]!;
    await deleteAttendee(attendee.id);
    // The greedy create already recorded a visit + booking for this contact;
    // undo it now that the order is being rolled back. Best-effort: callers
    // such as the paid webhook refund after this returns, so a contact-stats
    // write failure must not escape here and skip the refund.
    await bestEffort("reverseOrderActivity on partial rollback", () =>
      reverseOrderActivity(attendee.email, attendee.phone, source),
    );
  }
  return {
    ok: false,
    reason: result.success ? "capacity_exceeded" : result.reason,
  };
};

/** Order-level fields shared by every booking in one atomic create. */
type AttendeeOrderFields = {
  statusId: number | null;
  remainingBalance: number;
};

/** Build an INSERT statement for the attendees table from encrypted fields. */
export const buildAttendeeInsert = (
  enc: EncryptedAttendeeData,
  order: AttendeeOrderFields,
) =>
  insert("attendees", {
    created: enc.created,
    pii_blob: enc.encryptedPiiBlob,
    remaining_balance: order.remainingBalance,
    status_id: order.statusId,
    ticket_token_index: enc.ticketTokenIndex,
  });

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  id: Number(input.insertId),
  listing_id: input.listingId,
  ...contactFields(input),
  attachment_downloads: 0,
  checked_in: false,
  created: input.created,
  date: input.date,
  // Exclusive end (start + duration), matching SUBSTR(end_at) on the read path.
  // Null for date-less bookings, where no range is stored.
  end_date: input.date
    ? addDays(input.date, normalizeDurationDays(input.durationDays ?? 1))
    : null,
  payment_id: input.paymentId,
  pii_blob: "",
  price_paid: String(input.pricePaid),
  quantity: input.quantity,
  refunded: false,
  remaining_balance: input.remainingBalance,
  split_logistics_agents: false,
  status_id: input.statusId,
  ticket_token: input.ticketToken,
  ticket_token_index: input.ticketTokenIndex,
});

/** Collect the contact-identity hashes for an order (email and/or phone). */
const orderContactHashes = (
  email: unknown,
  phone: unknown,
): Promise<string[]> => {
  const hashes: Promise<string>[] = [];
  if (typeof email === "string" && email.trim()) {
    hashes.push(hashEmail(email));
  }
  if (typeof phone === "string" && phone.trim()) {
    hashes.push(hashPhone(phone));
  }
  return Promise.all(hashes);
};

/** Apply a visit + source-tagged booking change to every contact on an order.
 * Curried over the per-hash primitives so recording and its exact reverse share
 * one implementation. */
const applyOrderActivity =
  (
    visitFn: (hash: string) => Promise<void>,
    bookingFn: (hash: string, source: BookingSource) => Promise<void>,
  ) =>
  async (email: unknown, phone: unknown, source: BookingSource) => {
    for (const hash of await orderContactHashes(email, phone)) {
      await visitFn(hash);
      await bookingFn(hash, source);
    }
  };

const recordOrderActivity = applyOrderActivity(recordVisit, recordBooking);

/** Reverse {@link recordOrderActivity} when an order is rolled back after the
 * greedy create already recorded it (partial booking, post-payment refund). */
export const reverseOrderActivity = applyOrderActivity(
  unrecordVisit,
  unrecordBooking,
);

/**
 * Atomically create an attendee linked to one or more listings.
 * Single ACID batch transaction:
 *   1. INSERT attendee (unconditional)
 *   2..N+1. For each booking: INSERT listing_attendees with capacity check
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
    statusId = null,
    remainingBalance = 0,
    allowOverbook = false,
    source = "public",
  } = input;
  const order = { remainingBalance, statusId };
  if (bookings.length === 0) {
    return { reason: "capacity_exceeded", success: false };
  }
  // Reject negative quantities outright — the atomic insert would happily
  // store a negative row and skew future capacity sums.
  if (bookings.some((b) => (b.quantity ?? 1) < 0)) {
    return { reason: "capacity_exceeded", success: false };
  }
  // Reject duplicate (listing_id, date) pairs in a single cart. The
  // listing_attendees unique index is on (listing_id, attendee_id, start_at),
  // so two rows with the same tuple would violate it — silently dropping
  // one insert and delivering a half-fulfilled booking.
  if (hasDuplicateBookingSlot(bookings)) {
    return { reason: "capacity_exceeded", success: false };
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
  // booking would get the listing_attendees row ID instead of the attendee ID.
  const attendeeIdExpr =
    "(SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?)";
  const bookingStatements = bookings.map((booking) => {
    const insert = buildCapacityCheckedInsert(
      booking,
      attendeeIdExpr,
      undefined,
      allowOverbook,
    );
    // Splice ticketTokenIndex after the first arg (listingId) to bind
    // the ? in the attendeeIdExpr subquery
    const combined: InValue[] = [
      insert.args[0]!,
      enc.ticketTokenIndex,
      ...insert.args.slice(1),
    ];
    return { args: combined, sql: insert.sql };
  });

  // Single ACID transaction: attendee first, then capacity-checked listing links.
  // If all capacity checks fail, the attendee is cleaned up in the final step.
  const batchResults = await executeBatchWithResults([
    // Step 1: Create attendee record (unconditional)
    buildAttendeeInsert(enc, order),
    // Steps 2..N+1: One capacity-checked INSERT per booking
    ...bookingStatements,
    // Final step: Clean up attendee if no listing links were created
    {
      args: [enc.ticketTokenIndex, enc.ticketTokenIndex],
      sql: `DELETE FROM attendees WHERE id = (
              SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
            ) AND NOT EXISTS (
              SELECT 1 FROM listing_attendees WHERE attendee_id = (
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
          insertId: batchResults[0]!.lastInsertRowid,
          listingId: booking.listingId,
          ...contactInfo,
          created: enc.created,
          date: booking.date ?? null,
          durationDays: booking.durationDays,
          paymentId,
          pricePaid: booking.pricePaid ?? 0,
          quantity: booking.quantity ?? 1,
          remainingBalance,
          statusId,
          ticketToken: enc.ticketToken,
          ticketTokenIndex: enc.ticketTokenIndex,
        }),
      );
    }
  }

  if (successfulBookings.length === 0) {
    return { reason: "capacity_exceeded", success: false };
  }

  // Record one order-level visit and one source-tagged booking per contact
  // identity. Multi-listing carts still count as one customer visit/booking,
  // while email and phone can both recognize the customer on future checkouts.
  // A no-quantity-only order (every line a quantity-0 sentinel — an
  // interested/cancelled placeholder) is NOT a real visit or booking: counting
  // it would let a ghost-only contact qualify as "returning" via min_visits
  // gating. Gate on the order having ≥1 real line. (The only ghost-creating path
  // is the admin manual add, which overbooks and never hits the partial-rollback
  // reverse, so the reverse staying ungated can't double-decrement here.)
  if (successfulBookings.some((b) => b.quantity > 0)) {
    await recordOrderActivity(email, phone, source);
  }

  return { attendees: successfulBookings, success: true };
};
