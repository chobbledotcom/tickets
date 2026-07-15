/**
 * Atomic attendee creation across one or more listing bookings.
 */

import type { InValue } from "@libsql/client";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { addDays } from "#shared/dates.ts";
import type {
  AttendeeInput,
  BuildAttendeeInput,
  CreateAttendeeResult,
  EncryptedAttendeeData,
} from "#shared/db/attendee-types.ts";
import { hasDuplicateBookingSlot } from "#shared/db/attendees/booking-slot.ts";
import { buildCapacityCheckedInsert } from "#shared/db/attendees/capacity/checks.ts";
import {
  ATTENDEE_BY_TOKEN_SQL,
  type BookingBatchPlan,
  bookingBatchCondition,
  isModifierStockFailure,
  type LedgerPoster,
  type PreparedWrite,
  type WriteOutcome,
  writeAsBatch,
  writeAsLedgerBatch,
  writeWithLedger,
} from "#shared/db/attendees/create-batch.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { annotateOrderParents } from "#shared/db/attendees/order-parents.ts";
import {
  ATTENDEE_ECHO_DEFAULTS,
  attendeeContactInfo,
  attendeeEncryptionInput,
  contactFields,
  encryptAttendeeFields,
} from "#shared/db/attendees/pii.ts";
import { insert, type SqlStatement } from "#shared/db/client.ts";
import { recordOrderActivity } from "#shared/db/contact-tokens.ts";
import { type Attendee, normalizeDurationDays } from "#shared/types.ts";

/** Order-level fields shared by every booking in one atomic create. */
type AttendeeOrderFields = {
  kind?: string | undefined;
  statusId: number | null;
  remainingBalance: number;
};

/** Build an INSERT statement for the attendees table from encrypted fields.
 *  The outstanding balance is no longer a stored column — it projects from the
 *  transfers ledger as −balanceOf(attendee) — so the insert never writes it; a
 *  booking that owes money records the owed amount with its sale leg instead. */
export const buildAttendeeInsert = (
  enc: EncryptedAttendeeData,
  order: AttendeeOrderFields,
) =>
  insert("attendees", {
    created: enc.created,
    kind: order.kind ?? ATTENDEE_KIND,
    pii_blob: enc.encryptedPiiBlob,
    status_id: order.statusId,
    ticket_token_index: enc.ticketTokenIndex,
  });

/** Build plain Attendee object from insert result */
const buildAttendeeResult = (input: BuildAttendeeInput): Attendee => ({
  id: Number(input.insertId),
  listing_id: input.listingId,
  ...contactFields(input),
  ...ATTENDEE_ECHO_DEFAULTS,
  created: input.created,
  date: input.date,
  // Exclusive end (start + duration), matching SUBSTR(end_at) on the read path.
  // Null for date-less bookings, where no range is stored.
  end_date: input.date
    ? addDays(input.date, normalizeDurationDays(input.durationDays ?? 1))
    : null,
  kind: input.kind,
  package_group_id: input.packageGroupId,
  payment_id: input.paymentId,
  price_paid: String(input.pricePaid),
  quantity: input.quantity,
  remaining_balance: input.remainingBalance,
  status_id: input.statusId,
  ticket_token: input.ticketToken,
  ticket_token_index: input.ticketTokenIndex,
});

/**
 * Validate the order and encrypt the attendee, returning the attendee INSERT and
 * the capacity-checked booking INSERTs — or a failure reason. `extraCondition` is
 * AND-ed into every booking's WHERE (the batch booking path folds in the
 * all-modifiers-in-stock guard so a sold-out add-on stops the booking landing).
 * Shared by every create strategy so validation/encryption lives in one place. */
const prepareAttendeeWrite = async (
  input: AttendeeInput,
  extraCondition?: SqlStatement,
): Promise<
  | { ok: true; prepared: PreparedWrite }
  | { ok: false; failure: Extract<CreateAttendeeResult, { success: false }> }
> => {
  const {
    bookings: rawBookings,
    paymentId = "",
    statusId = null,
    remainingBalance = 0,
    allowOverbook = false,
  } = input;
  // Reject empty orders, negative quantities (a negative row skews capacity
  // sums), and duplicate (listing_id, date, parentListingId) slots (the unique
  // index would drop one insert and half-fulfil the cart).
  if (
    rawBookings.length === 0 ||
    rawBookings.some((b) => (b.quantity ?? 1) < 0) ||
    hasDuplicateBookingSlot(rawBookings)
  ) {
    return {
      failure: { reason: "capacity_exceeded", success: false },
      ok: false,
    };
  }

  // Tag the order's rows with a shared token and each chosen child's parent,
  // recomputed from the persisted parent/child edges (additive metadata only —
  // pricing, capacity and availability are untouched). One choke point for every
  // create caller (public free/paid webhook, admin manual add), so the free and
  // paid paths persist the pairing identically without a round-trip change.
  // Each row's `packageGroupId` (which bundle it was booked through, 0 = none)
  // arrives already stamped by the caller — an order can carry several
  // packages, so there is no order-level value to apply here.
  const bookings = await annotateOrderParents(rawBookings);

  const enc = await encryptAttendeeFields(
    attendeeEncryptionInput({ ...input, bookings }, paymentId),
    input.ticketToken ?? generateTicketToken(),
  );
  if (!enc) {
    return {
      failure: { reason: "encryption_error", success: false },
      ok: false,
    };
  }

  const bookingStatements = bookings.map((booking) => {
    const insert = buildCapacityCheckedInsert(
      booking,
      ATTENDEE_BY_TOKEN_SQL,
      undefined,
      allowOverbook,
    );
    // Splice ticketTokenIndex after listingId to bind the ? in the subquery,
    // then AND in the extra condition (its args trail the capacity args).
    const combined: InValue[] = [
      insert.args[0]!,
      enc.ticketTokenIndex,
      ...insert.args.slice(1),
      ...(extraCondition && !allowOverbook ? extraCondition.args : []),
    ];
    const sql =
      extraCondition && !allowOverbook
        ? `${insert.sql} AND (${extraCondition.sql})`
        : insert.sql;
    return { args: combined, sql };
  });

  return {
    ok: true,
    prepared: {
      attendeeInsert: buildAttendeeInsert(enc, {
        kind: input.kind,
        remainingBalance,
        statusId,
      }),
      bookingStatements,
      enc,
    },
  };
};

/**
 * Turn a successful write into the per-booking Attendee results and record the
 * order's contact activity (one visit + booking per identity). A no-quantity-only
 * order is not a real visit/booking, so the activity is gated on a real line.
 * Shared by every create strategy. */
const finishAttendeeWrite = async (
  written: WriteOutcome,
  input: AttendeeInput,
  enc: EncryptedAttendeeData,
): Promise<CreateAttendeeResult> => {
  const { bookings, source = "public" } = input;
  const contactInfo = attendeeContactInfo(input);
  const successfulBookings: Attendee[] = bookings.map((booking) =>
    buildAttendeeResult({
      insertId: written.insertId,
      listingId: booking.listingId,
      ...contactInfo,
      created: enc.created,
      date: booking.date ?? null,
      ...(booking.durationDays !== undefined
        ? { durationDays: booking.durationDays }
        : {}),
      kind: input.kind ?? ATTENDEE_KIND,
      packageGroupId: booking.packageGroupId ?? 0,
      paymentId: input.paymentId ?? "",
      pricePaid: booking.pricePaid ?? 0,
      quantity: booking.quantity ?? 1,
      remainingBalance: input.remainingBalance ?? 0,
      statusId: input.statusId ?? null,
      ticketToken: enc.ticketToken,
      ticketTokenIndex: enc.ticketTokenIndex,
    }),
  );
  if (successfulBookings.some((b) => b.quantity > 0)) {
    await recordOrderActivity(
      contactInfo.email,
      contactInfo.phone,
      source,
      enc.ticketToken,
    );
  }
  return { attendees: successfulBookings, success: true };
};

/** What one create strategy supplies to {@link createWith}: the extra booking
 *  WHERE condition (the batch path's modifier-stock guard), the write strategy
 *  (interactive transaction or batch), and what "no booking landed" means for
 *  that path (plain capacity failure, or — for the batch — possibly sold-out). */
type CreateStrategy<R extends CreateAttendeeResult | "sold-out"> = {
  condition?: SqlStatement;
  write: (prepared: PreparedWrite) => Promise<WriteOutcome | null>;
  noBooking: () => R | Promise<R>;
};

/**
 * The one create pipeline, curried over the per-strategy parts: prepare
 * (validate + encrypt + build the attendee/booking inserts) → run the write →
 * on success finish (build results + record contact activity); a prepare failure
 * or a no-booking write returns the strategy's failure. Both public creators are
 * thin specialisations, so the prepare/finish glue lives in exactly one place. */
const createWith =
  <R extends CreateAttendeeResult | "sold-out">(strategy: CreateStrategy<R>) =>
  async (input: AttendeeInput): Promise<CreateAttendeeResult | R> => {
    const prep = await prepareAttendeeWrite(input, strategy.condition);
    if (!prep.ok) return prep.failure;
    const written = await strategy.write(prep.prepared);
    return written
      ? finishAttendeeWrite(written, input, prep.prepared.enc)
      : strategy.noBooking();
  };

const capacityFailure = (): CreateAttendeeResult => ({
  reason: "capacity_exceeded",
  success: false,
});

/**
 * Atomically create an attendee linked to one or more listings.
 *   1. INSERT attendee (unconditional)
 *   2..N+1. For each booking: INSERT listing_attendees with capacity check
 *   3. Abort and roll back the whole batch if any capacity check fails
 * Returns one Attendee per successful booking. When `postLedger` is given, the
 * write runs in one interactive transaction and the ledger legs are posted in
 * it, so the booking and its legs are all-or-nothing.
 */
export const createAttendeeAtomicImpl = (
  input: AttendeeInput,
  postLedger?: LedgerPoster,
): Promise<CreateAttendeeResult> =>
  createWith<CreateAttendeeResult>({
    noBooking: capacityFailure,
    write: (prepared) =>
      postLedger
        ? writeWithLedger(prepared, postLedger)
        : writeAsBatch(prepared),
  })(input);

/**
 * Create a booking and post its ledger legs as ONE libsql batch. The
 * booking, its modifier-stock consumes, its sale/payment legs, the booking-row
 * event-group stamp, and (when finalizing a paid session) the session finalize
 * all commit or roll back together. Each booking insert is followed by a guard
 * that aborts the batch on a miss, so no compensating deletes are needed.
 *
 * Returns `"sold-out"` when a chosen modifier had no stock left (the
 * stock-guarded booking insert lands no row), so the caller keeps a placeholder
 * and refunds; otherwise the usual all-or-nothing create result. */
export const createBookingAtomic = async (
  input: AttendeeInput,
  plan: BookingBatchPlan,
): Promise<CreateAttendeeResult | "sold-out"> => {
  try {
    return await createWith<CreateAttendeeResult>({
      condition: bookingBatchCondition(plan),
      noBooking: capacityFailure,
      write: (prepared) => writeAsLedgerBatch(prepared, plan),
    })(input);
  } catch (error) {
    if (isModifierStockFailure(error)) return "sold-out";
    throw error;
  }
};
