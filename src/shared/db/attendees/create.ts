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
import { annotateOrderParents } from "#shared/db/attendees/order-parents.ts";
import {
  contactFields,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import {
  executeBatchWithResults,
  insert,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
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

type Statement = { sql: string; args: InValue[] };

/** Per-booking success flags and the new attendee row id (always set in
 *  practice — an INSERT returns its rowid). */
type WriteOutcome = { flags: boolean[]; insertId: number | bigint | undefined };

/** Posts the ledger legs for a created attendee inside the same transaction, so
 *  a booking and its legs commit or roll back together. The id is only known
 *  after the attendee insert, so it is passed in. */
export type LedgerPoster = (tx: TxScope, attendeeId: number) => Promise<void>;

/** Thrown to roll the transaction back when no booking could be created (the
 *  ledger-posting path has no final cleanup DELETE; it just rolls back). */
class NoBookingsCreated extends Error {}

/** Remove the just-inserted attendee when none of its capacity-checked booking
 *  inserts landed a row (the batch path's all-failed cleanup). */
const cleanupDeleteStatement = (ticketTokenIndex: InValue): Statement => ({
  args: [ticketTokenIndex, ticketTokenIndex],
  sql: `DELETE FROM attendees WHERE id = (
          SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
        ) AND NOT EXISTS (
          SELECT 1 FROM listing_attendees WHERE attendee_id = (
            SELECT MAX(id) FROM attendees WHERE ticket_token_index = ?
          )
        )`,
});

/** The fast path: one ACID batch (attendee, bookings, all-failed cleanup).
 *  Returns null when no booking landed (the attendee was cleaned up). */
const writeAsBatch = async (
  attendeeInsert: Statement,
  bookingStatements: Statement[],
  ticketTokenIndex: InValue,
): Promise<WriteOutcome | null> => {
  const batchResults = await executeBatchWithResults([
    attendeeInsert,
    ...bookingStatements,
    cleanupDeleteStatement(ticketTokenIndex),
  ]);
  const flags = bookingStatements.map(
    (_, i) => batchResults[i + 1]!.rowsAffected > 0,
  );
  return flags.some(Boolean)
    ? { flags, insertId: batchResults[0]!.lastInsertRowid }
    : null;
};

/** The ledger path: an interactive transaction so the ledger legs commit
 *  atomically with the attendee and bookings. This path is all-or-nothing —
 *  the legs describe the whole order, so if any booking fails its capacity check
 *  the transaction rolls back and null is returned (the caller refunds), rather
 *  than posting legs for listings that were not booked. */
const writeWithLedger = (
  attendeeInsert: Statement,
  bookingStatements: Statement[],
  postLedger: LedgerPoster,
): Promise<WriteOutcome | null> =>
  withTransaction<WriteOutcome>(async (tx) => {
    const insertId = (await tx.execute(attendeeInsert)).lastInsertRowid;
    const flags: boolean[] = [];
    for (const statement of bookingStatements) {
      flags.push((await tx.execute(statement)).rowsAffected > 0);
    }
    if (!flags.every(Boolean)) throw new NoBookingsCreated();
    await postLedger(tx, Number(insertId));
    return { flags, insertId };
  }).catch((error) => {
    if (error instanceof NoBookingsCreated) return null;
    throw error;
  });

/**
 * Atomically create an attendee linked to one or more listings.
 *   1. INSERT attendee (unconditional)
 *   2..N+1. For each booking: INSERT listing_attendees with capacity check
 *   3. Clean up / roll back the attendee if ALL capacity checks failed
 * Returns one Attendee per successful booking. When `postLedger` is given, the
 * write runs in one interactive transaction and the ledger legs are posted in
 * it, so the booking and its legs are all-or-nothing.
 */
export const createAttendeeAtomicImpl = async (
  input: AttendeeInput,
  postLedger?: LedgerPoster,
): Promise<CreateAttendeeResult> => {
  const {
    name,
    email,
    paymentId = "",
    phone = "",
    address = "",
    special_instructions = "",
    bookings: rawBookings,
    statusId = null,
    remainingBalance = 0,
    allowOverbook = false,
    source = "public",
  } = input;
  const order = { remainingBalance, statusId };
  if (rawBookings.length === 0) {
    return { reason: "capacity_exceeded", success: false };
  }
  // Reject negative quantities outright — the atomic insert would happily
  // store a negative row and skew future capacity sums.
  if (rawBookings.some((b) => (b.quantity ?? 1) < 0)) {
    return { reason: "capacity_exceeded", success: false };
  }
  // Reject duplicate (listing_id, date) pairs in a single cart. The
  // listing_attendees unique index is on (listing_id, attendee_id, start_at),
  // so two rows with the same tuple would violate it — silently dropping
  // one insert and delivering a half-fulfilled booking.
  if (hasDuplicateBookingSlot(rawBookings)) {
    return { reason: "capacity_exceeded", success: false };
  }

  // Tag the order's rows with a shared token and each chosen child's parent,
  // recomputed from the persisted parent/child edges (additive metadata only —
  // pricing, capacity and availability are untouched). One choke point for every
  // create caller (public free/paid webhook, admin manual add), so the free and
  // paid paths persist the pairing identically without a round-trip change.
  const bookings = await annotateOrderParents(rawBookings);

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

  // Attendee first, then capacity-checked listing links — atomically. The
  // ledger path runs an interactive transaction so it can also post the legs;
  // the plain path uses one batch with an all-failed cleanup DELETE.
  const attendeeInsert = buildAttendeeInsert(enc, order);
  const written = postLedger
    ? await writeWithLedger(attendeeInsert, bookingStatements, postLedger)
    : await writeAsBatch(
        attendeeInsert,
        bookingStatements,
        enc.ticketTokenIndex,
      );

  if (!written) {
    return { reason: "capacity_exceeded", success: false };
  }

  const successfulBookings: Attendee[] = bookings.flatMap((booking, i) =>
    written.flags[i]
      ? [
          buildAttendeeResult({
            insertId: written.insertId,
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
        ]
      : [],
  );

  // Record one order-level visit and one source-tagged booking per contact
  // identity. Multi-listing carts still count as one customer visit/booking,
  // while email and phone can both recognize the customer on future checkouts.
  await recordOrderActivity(email, phone, source);

  return { attendees: successfulBookings, success: true };
};
